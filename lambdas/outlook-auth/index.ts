import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const secrets = new SecretsManagerClient({});
const clientId = process.env.OUTLOOK_CLIENT_ID ?? "";
const authority = (process.env.OUTLOOK_AUTHORITY ?? "https://login.microsoftonline.com/common").replace(/\/$/, "");
const redirectUri = process.env.OUTLOOK_REDIRECT_URI ?? "";
const clientSecretArn = process.env.OUTLOOK_CLIENT_SECRET_SECRET_ARN ?? "";
const refreshTokenSecretArn = process.env.OUTLOOK_REFRESH_TOKEN_SECRET_ARN ?? "";
const stateSecretArn = process.env.OUTLOOK_STATE_SECRET_ARN ?? "";
const allowedUserEmail = (process.env.OUTLOOK_ALLOWED_USER_EMAIL ?? "").trim().toLowerCase();

const scopes = ["openid", "profile", "offline_access", "User.Read", "Calendars.Read"];
const stateLifetimeSeconds = 10 * 60;

const getSecret = async (secretId: string): Promise<string> => {
  if (!secretId) throw new Error("Secret ARN is not configured");
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  return result.SecretString ?? "";
};

const createState = (secret: string): string => {
  const payload = `${Math.floor(Date.now() / 1000)}.${randomBytes(16).toString("hex")}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
};

const verifyState = (state: string, secret: string): boolean => {
  const [encodedPayload, signature] = state.split(".");
  if (!encodedPayload || !signature) return false;

  const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (signature.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  const timestamp = Number(payload.split(".")[0]);
  return Number.isFinite(timestamp) && Math.floor(Date.now() / 1000) - timestamp <= stateLifetimeSeconds;
};

const response = (statusCode: number, body: string): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body,
});

const startAuth = async (): Promise<APIGatewayProxyResultV2> => {
  const stateSecret = await getSecret(stateSecretArn);
  const state = createState(stateSecret);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: scopes.join(" "),
    state,
  });
  return {
    statusCode: 302,
    headers: { location: `${authority}/oauth2/v2.0/authorize?${params.toString()}` },
  };
};

const callback = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const query = event.queryStringParameters ?? {};
  if (query.error) return response(400, `Microsoft認証に失敗しました: ${query.error}`);
  if (!query.code || !query.state) return response(400, "codeまたはstateが不足しています");

  const [clientSecret, stateSecret] = await Promise.all([
    getSecret(clientSecretArn),
    getSecret(stateSecretArn),
  ]);
  if (!verifyState(query.state, stateSecret)) return response(400, "stateが不正または期限切れです");

  const tokenResponse = await fetch(`${authority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: query.code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: scopes.join(" "),
    }).toString(),
  });

  if (!tokenResponse.ok) {
    console.error("Token exchange failed", tokenResponse.status, await tokenResponse.text());
    return response(502, "Microsoftからトークンを取得できませんでした");
  }

  const token = (await tokenResponse.json()) as { access_token?: string; refresh_token?: string };
  if (!token.refresh_token) return response(502, "refresh tokenが返されませんでした");

  if (!allowedUserEmail) {
    console.error("OUTLOOK_ALLOWED_USER_EMAIL is not configured");
    return response(500, "許可対象のMicrosoftアカウントが設定されていません");
  }

  const meResponse = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
    headers: { Authorization: `Bearer ${token.access_token ?? ""}` },
  });
  if (!meResponse.ok) return response(502, "Microsoftユーザー情報を確認できませんでした");
  const me = (await meResponse.json()) as { mail?: string; userPrincipalName?: string };
  const accountEmails = [me.mail, me.userPrincipalName]
    .filter((email): email is string => Boolean(email))
    .map((email) => email.toLowerCase());
  if (!accountEmails.includes(allowedUserEmail)) {
    console.warn("Rejected Microsoft account", accountEmails);
    return response(403, "許可されていないMicrosoftアカウントです");
  }

  await secrets.send(new PutSecretValueCommand({
    SecretId: refreshTokenSecretArn,
    SecretString: JSON.stringify({ refresh_token: token.refresh_token }),
  }));

  return response(200, "Outlook認証が完了しました。画面を閉じてください");
};

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const path = event.rawPath || "/";
    if (path === "/auth/start") return await startAuth();
    if (path === "/auth/callback") return await callback(event);
    return response(404, "Not Found");
  } catch (error) {
    console.error("OAuth handler failed", error);
    return response(500, "OAuth処理に失敗しました");
  }
};
