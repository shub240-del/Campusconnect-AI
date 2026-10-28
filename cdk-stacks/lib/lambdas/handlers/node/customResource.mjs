// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// PATCH v4.0.0 — SmallBiz AI Support Hub
//   • Replaced illegal require() calls with top-level ESM imports (Node 22 ESM)
//   • catch block now signals sendFailure to CloudFormation instead of fake sendSuccess
//   • Preserves all original Custom Resource handlers unchanged

import { configure, sendSuccess, sendFailure, sendResponse, LOG_VERBOSE, SUCCESS } from 'cfn-custom-resource';
import { PinpointSMSVoiceV2Client, UpdatePhoneNumberCommand, UpdateRcsAgentCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { SocialMessagingClient, PutWhatsAppBusinessAccountEventDestinationsCommand, ListLinkedWhatsAppBusinessAccountsCommand } from "@aws-sdk/client-socialmessaging";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import crypto from 'crypto';

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddbDocClient = DynamoDBDocument.from(dynamoDBClient);

const pinpointClient = new PinpointSMSVoiceV2Client({});
const socialMessagingClient = new SocialMessagingClient({});

/****************
 * Helper Functions
 ****************/
const setWhatsAppEventDestination = async (wabAccountId, snsTopicArn, roleArn) => {
  const input = {
    id: wabAccountId,
    eventDestinations: [
      {
        eventDestinationArn: snsTopicArn,
      }
    ]
  };

  console.trace(input)

  const command = new PutWhatsAppBusinessAccountEventDestinationsCommand(input);

  try {
    const response = await socialMessagingClient.send(command);
    console.log("Event destination set successfully:", response);
    return response;
  } catch (error) {
    console.error("Error setting event destination:", error);
    throw error;
  }
}

const whatsAppEventDestinationExists = async (wabaId) => {
  const input = {
    maxResults: 100,
  }
  
  try {
    const command = new ListLinkedWhatsAppBusinessAccountsCommand(input);
    const response = await socialMessagingClient.send(command);
    console.log("WhatsApp business accounts listed successfully:", response);
    for (const waba of response.linkedAccounts) {
      if (waba.id === wabaId) {
        if (waba.eventDestinations.length > 0) {
          return waba.eventDestinations[0].eventDestinationArn;
        } else {
          return false;
        }
      }
    }
    return false;
  } catch (error) {
    console.error("Error listing WhatsApp business accounts:", error);
    throw error;
  }
}

const updatePhoneNumber = async (props) => {
  try {
    const input = { 
      PhoneNumberId: props.SMSOriginationNumberId, 
      TwoWayEnabled: true,
      TwoWayChannelArn: props.ChatSNSTopicARN,
      TwoWayChannelRole: props.SNSRoleARN,
      SelfManagedOptOutsEnabled: false,
      DeletionProtectionEnabled: false,
    };
    console.trace(input)
    const command = new UpdatePhoneNumberCommand(input);
    const response = await pinpointClient.send(command);
    console.trace(response);
    return response
  }
  catch (error) {
      console.error(error);
      return false
  }
}

const updateRcsAgent = async (props) => {
  try {
    const input = {
      RcsAgentId: props.RcsAgentId,
      TwoWayEnabled: true,
      TwoWayChannelArn: props.ChatSNSTopicARN,
      TwoWayChannelRole: props.SNSRoleARN,
    };
    console.trace(input)
    const command = new UpdateRcsAgentCommand(input);
    const response = await pinpointClient.send(command);
    console.trace(response);
    return response
  }
  catch (error) {
      console.error(error);
      return false
  }
}

const putDynamoDBItem = async (tableName, item) => {
  const params = {
    TableName : tableName,
    Item: item
  }

  try {
    const results = await ddbDocClient.put(params);
    return results
  } catch (error) {
    console.error(error);
    throw error  // Propagate so CloudFormation receives FAILED, not fake SUCCESS
  }
}

/****************
 * Main
 ****************/
export const handler = async (event, context, callback) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    const props = event.ResourceProperties
    const requestType = event.RequestType
    let physicalId = event.PhysicalResourceId

    if (requestType === 'Create') {
        physicalId = `vce.eum-config.${crypto.randomUUID()}`
    } else if(!physicalId) {
        // PATCH: signal genuine failure to CloudFormation
        await sendFailure(physicalId || 'unknown', {}, event, `invalid request: request type is '${requestType}' but 'PhysicalResourceId' is not defined`)
        return
    }

    try{
      switch (event.ResourceType){
        case 'Custom::EUMConfig':
          if (requestType === 'Create' || requestType === 'Update'){
            await updatePhoneNumber(props);
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else if(requestType === 'Delete'){
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else {
            const result = await sendSuccess(physicalId, { }, event);
            return result
          }

        case 'Custom::RCSConfig':
          if (requestType === 'Create' || requestType === 'Update'){
            await updateRcsAgent(props);
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else if(requestType === 'Delete'){
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else {
            const result = await sendSuccess(physicalId, { }, event);
            return result
          }

        case 'Custom::SetWhatsAppEventDestination':
          if (requestType === 'Create' || requestType === 'Update'){
            let eventDestinationExists = await whatsAppEventDestinationExists(props.WhatsAppBusinessAccountId)
            if (!eventDestinationExists) {
              await setWhatsAppEventDestination(props.WhatsAppBusinessAccountId, props.SNSTopicARN, props.SNSRoleARN)
            }
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else {
            const result = await sendSuccess(physicalId, { }, event);
            return result
          }

        case 'Custom::PutDynamoDBData':
          if (requestType === 'Create' || requestType === 'Update'){
            // PATCH: putDynamoDBItem now throws on failure — error bubbles to catch below
            await putDynamoDBItem(props.UseCaseTableName, JSON.parse(props.Data))
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else {
            const result = await sendSuccess(physicalId, { }, event);
            return result
          }

        default:
          const result = await sendSuccess(physicalId, { }, event);
          return result
      }
    }
    catch (ex){
      // PATCH: propagate real failures to CloudFormation so stacks don't silently succeed
      // with an empty DynamoDB configuration table
      console.error('CustomResource handler error:', ex);
      const result = await sendFailure(physicalId, { }, event, ex.message || 'Custom resource handler failed');
      return result
    }
};
