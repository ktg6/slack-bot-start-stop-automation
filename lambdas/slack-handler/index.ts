import { App, BlockAction, verifySlackRequest } from "@slack/bolt";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";

const sfn = new SFNClient({});
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

const stepFunctionsArn = process.env.STEP_FUNCTIONS_ARN ?? "";
const slackChannelId = process.env.SLACK_CHANNEL_ID ?? "";
const slackBotTokenSecretArn = process.env.SLACK_BOT_TOKEN_SECRET_ARN ?? "";
const slackSigningSecretSecretArn = process.env.SLACK_SIGNING_SECRET_ARN ?? "";

let appPromise: Promise<{ app: App; signingSecret: string }> | null = null;

// 環境リスト
const ENVIRONMENTS = [
  { text: "dev", value: "dev" },
  { text: "staging", value: "staging" },
  { text: "prod", value: "prod" },
];

// SSM Parameter Store から値取得
const getParameter = async (name: string): Promise<string> => {
  const result = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return result.Parameter?.Value ?? "";
};

const getSecret = async (secretArn: string): Promise<string> => {
  if (!secretArn) return "";
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  return result.SecretString ?? "";
};

const registerHandlers = (app: App): void => {
  // /start-stop コマンド: モーダルを表示
  app.command("/start-stop", async ({ ack, body, client }) => {
    if (body.channel_id !== slackChannelId) {
      await ack({
        response_type: "ephemeral",
        text: "このチャンネルでは実行できません。",
      });
      return;
    }

    await ack();

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "start_stop_modal",
        title: { type: "plain_text", text: "起動停止操作" },
        submit: { type: "plain_text", text: "実行" },
        close: { type: "plain_text", text: "キャンセル" },
        blocks: [
          {
            type: "section",
            block_id: "action_block",
            text: { type: "mrkdwn", text: "*アクションを選択*" },
            accessory: {
              type: "static_select",
              action_id: "action_select",
              placeholder: { type: "plain_text", text: "選択してください" },
              options: [
                {
                  text: { type: "plain_text", text: "▶️ 起動" },
                  value: "start",
                },
                {
                  text: { type: "plain_text", text: "⏹️ 停止" },
                  value: "stop",
                },
              ],
            },
          },
          {
            type: "section",
            block_id: "environment_block",
            text: { type: "mrkdwn", text: "*環境を選択*" },
            accessory: {
              type: "static_select",
              action_id: "environment_select",
              placeholder: { type: "plain_text", text: "選択してください" },
              options: ENVIRONMENTS.map((env) => ({
                text: { type: "plain_text", text: env.text },
                value: env.value,
              })),
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: ":warning: 本番環境の操作は慎重に行ってください",
              },
            ],
          },
        ],
      },
    });
  });

  // モーダル送信時の処理
  app.view("start_stop_modal", async ({ ack, body, view, client }) => {
    const actionValue =
      view.state.values.action_block?.action_select?.selected_option?.value;
    const environmentValue =
      view.state.values.environment_block?.environment_select?.selected_option?.value;

    if (!actionValue || !environmentValue) {
      await ack({
        response_action: "errors",
        errors: {
          action_block: !actionValue ? "アクションを選択してください" : "",
          environment_block: !environmentValue ? "環境を選択してください" : "",
        },
      });
      return;
    }

    const userId = body.user.id;
    // SSM Parameter Storeから対象リソース情報取得
    const [ec2InstanceIdsRaw, rdsInstanceId] = await Promise.all([
      getParameter(`/start-stop/${environmentValue}/ec2-instance-ids`),
      getParameter(`/start-stop/${environmentValue}/rds-instance-id`),
    ]);

    const ec2InstanceIds = ec2InstanceIdsRaw.split(",").map((id) => id.trim());

    // Step Functions起動
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: stepFunctionsArn,
        input: JSON.stringify({
          action: actionValue,
          environment: environmentValue,
          ec2InstanceIds,
          rdsInstanceId,
          userId,
        }),
      })
    );

    console.log("Step Functions execution started", {
      action: actionValue,
      environment: environmentValue,
      userId,
    });

    // Step Functionsの起動完了後にSlackへ受付成功を返す。
    // ack後に非同期処理を残すと、Lambda終了時に処理が中断される可能性がある。
    await ack();

  });

  // Slack Block Actionハンドラ（モーダル内のselect操作を受け取るため）
  app.action<BlockAction>("action_select", async ({ ack }) => { await ack(); });
  app.action<BlockAction>("environment_select", async ({ ack }) => { await ack(); });
};

const getApp = async (): Promise<{ app: App; signingSecret: string }> => {
  if (appPromise) return appPromise;

  appPromise = (async () => {
    const secretToken = await getSecret(slackBotTokenSecretArn);
    const secretSigningSecret = await getSecret(slackSigningSecretSecretArn);
    const botToken = secretToken || (process.env.SLACK_BOT_TOKEN ?? "");
    const signingSecret = secretSigningSecret || (process.env.SLACK_SIGNING_SECRET ?? "");

    if (!botToken || !signingSecret) {
      throw new Error("Slack token/signing secret is not configured");
    }

    const app = new App({ token: botToken, signingSecret });
    registerHandlers(app);
    return { app, signingSecret };
  })();

  return appPromise;
};

// Function URLのHTTPイベントをPromise形式で直接処理する
export const handler = async (event: APIGatewayProxyEventV2, _context: Context) => {
  try {
    const { app, signingSecret } = await getApp();
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : event.body ?? "";
    const headers = Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value ?? ""]),
    );

    verifySlackRequest({
      signingSecret,
      body: rawBody,
      headers: {
        "x-slack-signature": headers["x-slack-signature"],
        "x-slack-request-timestamp": Number(headers["x-slack-request-timestamp"]),
      },
    });

    const contentType = headers["content-type"] ?? "";
    const parsedBody = contentType.includes("application/json")
      ? JSON.parse(rawBody)
      : Object.fromEntries(new URLSearchParams(rawBody));
    // Slackのモーダル操作は payload フォーム項目内にJSONで格納される。
    // Slash Commandはフォーム項目を直接送るため、payloadがある場合だけ展開する。
    const body = typeof parsedBody.payload === "string"
      ? JSON.parse(parsedBody.payload)
      : parsedBody;

    console.log("Slack event received", {
      type: body.type ?? "slash_command",
      command: body.command,
      callbackId: body.view?.callback_id,
      actionId: body.actions?.[0]?.action_id,
    });

    const response = await new Promise<unknown>((resolve, reject) => {
      let acknowledged = false;
      const ack = async (payload?: unknown) => {
        if (!acknowledged) {
          acknowledged = true;
          resolve(payload ?? {});
        }
      };
      void app.processEvent({ body, ack }).catch((error) => {
        console.error("Slack event processing error:", error);
        reject(error);
      });
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error("Slack Lambda execution error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal Server Error" }),
    };
  }
};
