import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose";
const firehoseClient = new FirehoseClient({});

export async function firehoseDirectPut(streamName, data) {
  const record = {
    DeliveryStreamName: streamName,
    Record: { Data: Buffer.from(JSON.stringify(data)) }
  };

  try {
    const command = new PutRecordCommand(record);
    const response = await firehoseClient.send(command);
    return response;
  } catch (error) {
    console.error("Firehose.firehoseDirectPut:", error);
    throw error;
  }
}

export default { firehoseDirectPut };