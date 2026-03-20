import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  RDSClient,
  StartDBInstanceCommand,
  StopDBInstanceCommand,
  DescribeDBInstancesCommand,
} from "@aws-sdk/client-rds";
import { WebClient } from "@slack/web-api";

const ec2 = new EC2Client({});
const rds = new RDSClient({});

const slackToken = process.env.SLACK_BOT_TOKEN ?? "";
const slackChannelId = process.env.SLACK_CHANNEL_ID ?? "";
const slack = new WebClient(slackToken);

// Step Functionsから渡されるイベント型
interface OperationEvent {
  operation: "start_ec2" | "stop_ec2" | "start_rds" | "stop_rds" | "check_ec2" | "check_rds" | "notify";
  ec2InstanceIds: string[];
  rdsInstanceId: string;
  action: "start" | "stop";
  environment: string;
  userId: string;
  error?: string;
}

interface OperationResult {
  status: string;
  ready: boolean;
  ec2InstanceIds: string[];
  rdsInstanceId: string;
  action: "start" | "stop";
  environment: string;
  userId: string;
}

const startEc2 = async (instanceIds: string[]): Promise<string> => {
  await ec2.send(new StartInstancesCommand({ InstanceIds: instanceIds }));
  return "starting";
};

const stopEc2 = async (instanceIds: string[]): Promise<string> => {
  await ec2.send(new StopInstancesCommand({ InstanceIds: instanceIds }));
  return "stopping";
};

const checkEc2Status = async (instanceIds: string[], targetState: string): Promise<boolean> => {
  const result = await ec2.send(
    new DescribeInstancesCommand({ InstanceIds: instanceIds })
  );
  const instances = result.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
  return instances.length > 0 && instances.every((i) => i.State?.Name === targetState);
};

const startRds = async (instanceId: string): Promise<string> => {
  await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
  return "starting";
};

const stopRds = async (instanceId: string): Promise<string> => {
  await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
  return "stopping";
};

const checkRdsStatus = async (instanceId: string, targetStatus: string): Promise<boolean> => {
  const result = await rds.send(
    new DescribeDBInstancesCommand({ DBInstanceIdentifier: instanceId })
  );
  const dbInstance = result.DBInstances?.[0];
  return dbInstance?.DBInstanceStatus === targetStatus;
};

const notifySlack = async (
  environment: string,
  action: string,
  userId: string,
  error?: string
): Promise<void> => {
  const status = error ? `:x: エラー` : `:white_check_mark: 完了`;
  const actionLabel = action === "start" ? "起動" : "停止";
  const text = error
    ? `*[${environment}] ${actionLabel}処理でエラーが発生しました*\n実行者: <@${userId}>\nエラー: ${error}`
    : `*[${environment}] ${actionLabel}処理が完了しました*\n実行者: <@${userId}>`;

  await slack.chat.postMessage({
    channel: slackChannelId,
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `${status} ${text}` },
      },
    ],
  });
};

export const handler = async (event: OperationEvent): Promise<OperationResult> => {
  const { operation, ec2InstanceIds, rdsInstanceId, action, environment, userId } = event;

  const baseResult: OperationResult = {
    status: "unknown",
    ready: false,
    ec2InstanceIds,
    rdsInstanceId,
    action,
    environment,
    userId,
  };

  switch (operation) {
    case "start_ec2": {
      const status = await startEc2(ec2InstanceIds);
      return { ...baseResult, status };
    }
    case "stop_ec2": {
      const status = await stopEc2(ec2InstanceIds);
      return { ...baseResult, status };
    }
    case "check_ec2": {
      const targetState = action === "start" ? "running" : "stopped";
      const ready = await checkEc2Status(ec2InstanceIds, targetState);
      return { ...baseResult, status: targetState, ready };
    }
    case "start_rds": {
      const status = await startRds(rdsInstanceId);
      return { ...baseResult, status };
    }
    case "stop_rds": {
      const status = await stopRds(rdsInstanceId);
      return { ...baseResult, status };
    }
    case "check_rds": {
      const targetStatus = action === "start" ? "available" : "stopped";
      const ready = await checkRdsStatus(rdsInstanceId, targetStatus);
      return { ...baseResult, status: targetStatus, ready };
    }
    case "notify": {
      await notifySlack(environment, action, userId, event.error);
      return { ...baseResult, status: "notified", ready: true };
    }
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
};
