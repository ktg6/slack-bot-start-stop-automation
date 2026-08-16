import {
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
  DeleteRuleCommand,
  RemoveTargetsCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
} from "@aws-sdk/client-eventbridge";
import {
  LambdaClient,
  AddPermissionCommand,
  RemovePermissionCommand,
} from "@aws-sdk/client-lambda";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { WebClient } from "@slack/web-api";

const eventbridge = new EventBridgeClient({});
const lambda = new LambdaClient({});
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

const stepFunctionsArn = process.env.STEP_FUNCTIONS_ARN ?? "";
const slackChannelId = process.env.SLACK_CHANNEL_ID ?? "";
const clientId = process.env.OUTLOOK_CLIENT_ID ?? "";
const outlookClientSecretSecretArn = process.env.OUTLOOK_CLIENT_SECRET_SECRET_ARN ?? "";
const sfnTriggerLambdaArn = process.env.SFN_TRIGGER_LAMBDA_ARN ?? "";
const awsRegion = process.env.AWS_REGION ?? "ap-northeast-1";
const awsAccountId = sfnTriggerLambdaArn.split(":")[4] ?? "";
const slackBotTokenSecretArn = process.env.SLACK_BOT_TOKEN_SECRET_ARN ?? "";
const outlookRefreshTokenSecretArn = process.env.OUTLOOK_REFRESH_TOKEN_SECRET_ARN ?? "";
const rulePrefix = "start-stop-";
const maxRules = parseInt(process.env.MAX_RULES ?? "40", 10);

let slackClientPromise: Promise<WebClient> | null = null;
let outlookRefreshTokenPromise: Promise<string> | null = null;
let outlookClientSecretPromise: Promise<string> | null = null;

// テスト運用ではOutlookカレンダーをdev環境だけに紐付ける
const OUTLOOK_ENVIRONMENT = "dev";

interface CalendarEvent {
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isCancelled: boolean;
}

const isUtcTimeZone = (timeZone: string): boolean =>
  ["UTC", "Coordinated Universal Time", "Etc/UTC"].includes(timeZone);

const toUtcDate = (dateTime: string, timeZone: string): Date => {
  // UTCで返された場合は、そのままUTCとして解釈する。
  if (isUtcTimeZone(timeZone)) {
    return new Date(`${dateTime}Z`);
  }

  // Tokyo Standard Timeなど、オフセットのない日本時間として返された場合。
  const jstDate = new Date(`${dateTime}Z`);
  return new Date(jstDate.getTime() - 9 * 60 * 60 * 1000);
};

interface ScheduleRule {
  name: string;
  environment: string;
  action: "start" | "stop";
  cronExpression: string;
  scheduledTime: Date;
}

const getSecret = async (secretArn: string): Promise<string> => {
  if (!secretArn) return "";
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  return result.SecretString ?? "";
};

const getSlackClient = async (): Promise<WebClient> => {
  if (slackClientPromise) return slackClientPromise;
  slackClientPromise = (async () => {
    const secretToken = await getSecret(slackBotTokenSecretArn);
    const slackToken = secretToken || (process.env.SLACK_BOT_TOKEN ?? "");
    if (!slackToken) {
      throw new Error("Slack bot token is not configured");
    }
    return new WebClient(slackToken);
  })();
  return slackClientPromise;
};

const getOutlookRefreshToken = async (): Promise<string> => {
  if (outlookRefreshTokenPromise) return outlookRefreshTokenPromise;
  outlookRefreshTokenPromise = (async () => {
    const secretValue = await getSecret(outlookRefreshTokenSecretArn);
    if (!secretValue) throw new Error("Outlook refresh token is not configured");
    try {
      const parsed = JSON.parse(secretValue) as { refresh_token?: string };
      if (!parsed.refresh_token) throw new Error("refresh_token is missing");
      return parsed.refresh_token;
    } catch (error) {
      throw new Error(`Invalid Outlook refresh token secret: ${String(error)}`);
    }
  })();
  return outlookRefreshTokenPromise;
};

const getOutlookClientSecret = async (): Promise<string> => {
  if (outlookClientSecretPromise) return outlookClientSecretPromise;
  outlookClientSecretPromise = getSecret(outlookClientSecretSecretArn);
  return outlookClientSecretPromise;
};

// OAuth 2.0 Refresh Token Flow で委任アクセストークンを取得
const getAccessToken = async (): Promise<string> => {
  const refreshToken = await getOutlookRefreshToken();
  const clientSecret = await getOutlookClientSecret();
  const tokenUrl = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    scope: "openid profile offline_access User.Read Calendars.Read",
    grant_type: "refresh_token",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
  };
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await secrets.send(new PutSecretValueCommand({
      SecretId: outlookRefreshTokenSecretArn,
      SecretString: JSON.stringify({ refresh_token: data.refresh_token }),
    }));
    outlookRefreshTokenPromise = Promise.resolve(data.refresh_token);
  }
  return data.access_token;
};

// Outlookカレンダーからイベント取得
const getCalendarEvents = async (accessToken: string): Promise<CalendarEvent[]> => {
  const now = new Date();
  const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const endDate = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  const url =
    "https://graph.microsoft.com/v1.0/me/calendarView" +
    `?startDateTime=${startDate.toISOString()}` +
    `&endDateTime=${endDate.toISOString()}` +
    `&$select=subject,start,end,isCancelled` +
    `&$top=100`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.timezone="Tokyo Standard Time"',
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(
      "Calendar request failed",
      response.status,
      response.headers.get("www-authenticate"),
      errorBody,
    );
    throw new Error(`Calendar request failed: ${response.status}`);
  }

  const data = (await response.json()) as { value: CalendarEvent[] };
  console.log("Outlook calendar events", {
    count: data.value.length,
    events: data.value.map((event) => ({
      subject: event.subject,
      start: event.start,
      end: event.end,
      isCancelled: event.isCancelled,
    })),
  });
  return data.value;
};

// Outlookイベントからルールを解析する。
// 件名は使用せず、開始時刻を起動、終了時刻を停止として扱う。
const parseEventToRules = (events: CalendarEvent[]): ScheduleRule[] => {
  const rules: ScheduleRule[] = [];

  for (const event of events) {
    if (event.isCancelled) continue;
    const addRule = (action: "start" | "stop", utcTime: Date): void => {
      if (utcTime < new Date()) return;

      // EventBridgeのCronはUTCのままにし、ルール名だけJSTで表記する。
      const jstTime = new Date(utcTime.getTime() + 9 * 60 * 60 * 1000);
      const ruleName =
        `${rulePrefix}${OUTLOOK_ENVIRONMENT}-${action}` +
        `-${jstTime.getUTCFullYear()}` +
        `${String(jstTime.getUTCMonth() + 1).padStart(2, "0")}` +
        `${String(jstTime.getUTCDate()).padStart(2, "0")}` +
        `-${String(jstTime.getUTCHours()).padStart(2, "0")}` +
        `${String(jstTime.getUTCMinutes()).padStart(2, "0")}`;

      rules.push({
        name: ruleName,
        environment: OUTLOOK_ENVIRONMENT,
        action,
        cronExpression:
          `cron(${utcTime.getUTCMinutes()} ${utcTime.getUTCHours()} ` +
          `${utcTime.getUTCDate()} ${utcTime.getUTCMonth() + 1} ? ` +
          `${utcTime.getUTCFullYear()})`,
        scheduledTime: utcTime,
      });
    };

    addRule(
      "start",
      toUtcDate(event.start.dateTime, event.start.timeZone),
    );
    addRule(
      "stop",
      toUtcDate(event.end.dateTime, event.end.timeZone),
    );
  }

  return rules;
};

// SSMからリソース情報取得
const getParameter = async (name: string): Promise<string> => {
  const result = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return result.Parameter?.Value ?? "";
};

// EventBridgeルール作成
const createRule = async (rule: ScheduleRule): Promise<void> => {
  const [ec2InstanceIdsRaw, rdsInstanceId] = await Promise.all([
    getParameter(`/start-stop/${rule.environment}/ec2-instance-ids`),
    getParameter(`/start-stop/${rule.environment}/rds-instance-id`),
  ]);

  const ec2InstanceIds = ec2InstanceIdsRaw.split(",").map((id) => id.trim());

  // ルール作成
  await eventbridge.send(
    new PutRuleCommand({
      Name: rule.name,
      ScheduleExpression: rule.cronExpression,
      State: "ENABLED",
      Description: `Auto-generated: ${rule.environment} ${rule.action}`,
    })
  );

  // ターゲット設定（Step Functionsトリガー用Lambda）
  const payload = JSON.stringify({
    action: rule.action,
    environment: rule.environment,
    ec2InstanceIds,
    rdsInstanceId,
    userId: "outlook-automation",
  });

  await eventbridge.send(
    new PutTargetsCommand({
      Rule: rule.name,
      Targets: [
        {
          Id: `${rule.name}-target`,
          Arn: sfnTriggerLambdaArn,
          Input: payload,
        },
      ],
    })
  );

  // Lambda実行権限付与
  try {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: sfnTriggerLambdaArn,
        StatementId: `${rule.name}-permission`,
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
        SourceArn: `arn:aws:events:${awsRegion}:${awsAccountId}:rule/${rule.name}`,
      })
    );
  } catch (err: unknown) {
    // 既に権限が存在する場合は無視
    if (!(err instanceof Error && err.name === "ResourceConflictException")) {
      throw err;
    }
  }
};

// EventBridgeルール削除
const deleteRule = async (ruleName: string): Promise<void> => {
  try {
    // ターゲット取得して削除
    const targets = await eventbridge.send(
      new ListTargetsByRuleCommand({ Rule: ruleName })
    );
    const targetIds = targets.Targets?.map((t) => t.Id ?? "") ?? [];

    if (targetIds.length > 0) {
      await eventbridge.send(
        new RemoveTargetsCommand({ Rule: ruleName, Ids: targetIds })
      );
    }

    // Lambda権限削除
    try {
      await lambda.send(
        new RemovePermissionCommand({
          FunctionName: sfnTriggerLambdaArn,
          StatementId: `${ruleName}-permission`,
        })
      );
    } catch {
      // 権限が存在しない場合は無視
    }

    await eventbridge.send(new DeleteRuleCommand({ Name: ruleName }));
  } catch (err: unknown) {
    console.error(`Failed to delete rule ${ruleName}:`, err);
  }
};

// 既存ルール取得
const getExistingRules = async (): Promise<string[]> => {
  const result = await eventbridge.send(
    new ListRulesCommand({ NamePrefix: rulePrefix })
  );
  return result.Rules?.map((r) => r.Name ?? "") ?? [];
};

// 当日の予定をSlack通知
const notifyTodaySchedule = async (rules: ScheduleRule[]): Promise<void> => {
  const slack = await getSlackClient();
  const now = new Date();
  const todayRules = rules.filter((r) => {
    const diff = r.scheduledTime.getTime() - now.getTime();
    return diff > 0 && diff < 24 * 60 * 60 * 1000;
  });

  if (todayRules.length === 0) return;

  const lines = todayRules.map((r) => {
    const jstTime = new Date(r.scheduledTime.getTime() + 9 * 60 * 60 * 1000);
    const timeStr = `${String(jstTime.getHours()).padStart(2, "0")}:${String(jstTime.getMinutes()).padStart(2, "0")}`;
    const actionLabel = r.action === "start" ? ":arrow_forward: 起動" : ":stop_button: 停止";
    return `- ${timeStr} *${r.environment}* ${actionLabel}`;
  });

  await slack.chat.postMessage({
    channel: slackChannelId,
    text: `:calendar: *本日の起動停止予定*\n${lines.join("\n")}`,
  });
};

// Outlook予定の追加・削除をSlack通知
const notifyScheduleChanges = async (
  created: ScheduleRule[],
  deleted: string[],
): Promise<void> => {
  if (created.length === 0 && deleted.length === 0) return;

  const slack = await getSlackClient();
  const lines = [
    ...created.map((rule) => `- :heavy_plus_sign: 追加 ${rule.name}`),
    ...deleted.map((name) => `- :wastebasket: 削除 ${name}`),
  ];

  await slack.chat.postMessage({
    channel: slackChannelId,
    text: `:calendar: *起動停止予定を更新しました*\n${lines.join("\n")}`,
  });
};

// メインハンドラ
export const handler = async (): Promise<{ statusCode: number; body: string }> => {
  let slack: WebClient | null = null;

  try {
    slack = await getSlackClient();

    // 1. Outlookカレンダーからイベント取得
    const accessToken = await getAccessToken();
    const events = await getCalendarEvents(accessToken);

    // 2. イベントをスケジュールルールに変換
    const desiredRules = parseEventToRules(events);
    console.log("Outlook desired rules", desiredRules.map((rule) => ({
      name: rule.name,
      environment: rule.environment,
      action: rule.action,
      scheduledTime: rule.scheduledTime.toISOString(),
    })));

    // ルール数上限チェック
    if (desiredRules.length > maxRules) {
      console.warn(`Rule count (${desiredRules.length}) exceeds max (${maxRules}). Truncating.`);
      desiredRules.splice(maxRules);
    }

    // 3. 既存ルールと比較
    const existingRuleNames = await getExistingRules();
    const desiredRuleNames = new Set(desiredRules.map((r) => r.name));

    // 不要なルールを削除
    const toDelete = existingRuleNames.filter((name) => !desiredRuleNames.has(name));
    for (const name of toDelete) {
      await deleteRule(name);
      console.log(`Deleted rule: ${name}`);
    }

    // 新規ルールを作成
    const existingSet = new Set(existingRuleNames);
    const toCreate = desiredRules.filter((r) => !existingSet.has(r.name));
    for (const rule of toCreate) {
      await createRule(rule);
      console.log(`Created rule: ${rule.name}`);
    }

    // 4. Outlook予定の変更を通知
    await notifyScheduleChanges(toCreate.map((r) => r), toDelete);

    // 5. 当日の予定をSlack通知（毎朝9時台の実行時のみ）
    const jstHour = (new Date().getUTCHours() + 9) % 24;
    if (jstHour === 9) {
      await notifyTodaySchedule(desiredRules);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        created: toCreate.length,
        deleted: toDelete.length,
        total: desiredRules.length,
      }),
    };
  } catch (err: unknown) {
    console.error("Outlook sync failed:", err);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
