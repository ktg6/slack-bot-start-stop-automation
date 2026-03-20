import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

const sfn = new SFNClient({});
const stepFunctionsArn = process.env.STEP_FUNCTIONS_ARN ?? "";

interface TriggerEvent {
  action: "start" | "stop";
  environment: string;
  ec2InstanceIds: string[];
  rdsInstanceId: string;
  userId: string;
}

export const handler = async (event: TriggerEvent): Promise<{ statusCode: number }> => {
  await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: stepFunctionsArn,
      input: JSON.stringify(event),
    })
  );
  return { statusCode: 200 };
};
