// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import BedrockService from '../services/BedrockService.mjs';
import Utilities from '../services/UtilitiesService.mjs';

export const handler = async (event, _context, callback) => {
    try {
        console.info("App Version:", process.env.APPLICATION_VERSION);
        console.trace(`Event: `, JSON.stringify(event, null, 2));

        const recipient = event.recipient;
        const useCase = event.useCase;
        const sessionId = event.sessionVariables?.sessionId;

        const sessionState = {
            "promptSessionAttributes": {
                "name": recipient.senderName,
                "phoneNumber": recipient.destinationAddress
            }
        };

        // If the first message is outbound, send message with instructions to the agent but do not send the response
        if (event.conversation?.length === 1 && event.conversation[0].direction === 'outbound') {
            const initialMessage = process.env.AGENT_PRELOAD_MESSAGE + event.conversation[0].message;
            const agentResponse = await BedrockService.invokeAgent(initialMessage, useCase, sessionId, sessionState);
            console.trace('preloadAgentResponse: ', agentResponse.completion);
        }

        const agentResponse = await BedrockService.invokeAgent(recipient.messageBody, useCase, sessionId, sessionState);
        console.trace('agentResponse: ', agentResponse);

        const response = agentResponse.completion;
        const source = 'Bedrock Agent';

        callback(null, { 'llmSessionId': sessionId, 'response': response, 'source': source });
    } catch (error) {
        console.error(error);
        callback(error);
    }
};

export default { handler };