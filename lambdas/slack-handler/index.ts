import {
  App,
  AwsLambdaReceiver,
  BlockAction,
} from "@slack/bolt";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import type { AwsEvent } from "@slack/bolt/dist/receivers/AwsLambdaReceiver";

const sfn = new SFNClient({});
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

const stepFunctionsArn = process.env.STEP_FUNCTIONS_ARN ?? "";
const slackChannelId = process.env.SLACK_CHANNEL_ID ?? "";
const slackBotTokenSecretArn = process.env.SLACK_BOT_TOKEN_SECRET_ARN ?? "";
const slackSigningSecretSecretArn = process.env.SLACK_SIGNING_SECRET_ARN ?? "";

let lambdaHandlerPromise: Promise<
  (event: AwsEvent, context: unknown, callback: unknown) => Promise<unknown>
> | null = null;

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
                  text: { type: "plain_text", text: ":arrow_forward: 起動" },
                  value: "start",
                },
                {
                  text: { type: "plain_text", text: ":stop_button: 停止" },
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

    await ack();

    const userId = body.user.id;
    const actionLabel = actionValue === "start" ? "起動" : "停止";

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

    // 即時応答
    await client.chat.postMessage({
      channel: slackChannelId,
      text: `<@${userId}> が *${environmentValue}* 環境の *${actionLabel}* 処理を開始しました :rocket:`,
    });
  });

  // Slack Block Actionハンドラ（モーダル内のselect操作を受け取るため）
  app.action<BlockAction>("action_select", async ({ ack }) => { await ack(); });
  app.action<BlockAction>("environment_select", async ({ ack }) => { await ack(); });
};

const getLambdaHandler = async (): Promise<
  (event: AwsEvent, context: unknown, callback: unknown) => Promise<unknown>
> => {
  if (lambdaHandlerPromise) return lambdaHandlerPromise;

  lambdaHandlerPromise = (async () => {
    const secretToken = await getSecret(slackBotTokenSecretArn);
    const secretSigningSecret = await getSecret(slackSigningSecretSecretArn);
    const botToken = secretToken || (process.env.SLACK_BOT_TOKEN ?? "");
    const signingSecret = secretSigningSecret || (process.env.SLACK_SIGNING_SECRET ?? "");

    if (!botToken || !signingSecret) {
      throw new Error("Slack token/signing secret is not configured");
    }

    const receiver = new AwsLambdaReceiver({ signingSecret });
    const app = new App({ token: botToken, receiver });
    registerHandlers(app);
    return receiver.start();
  })();

  return lambdaHandlerPromise;
};

// Lambda handler
export const handler = async (
  event: AwsEvent,
  context: unknown,
  callback: unknown
) => {
  const lambdaHandler = await getLambdaHandler();
  return lambdaHandler(event, context as never, callback as never);
};
