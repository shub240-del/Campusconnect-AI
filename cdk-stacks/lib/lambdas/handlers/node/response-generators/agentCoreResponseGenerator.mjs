// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";

export const handler = async (event, _context, callback) => {
    try {
        console.info("App Version:", process.env.APPLICATION_VERSION);
        console.trace(`Event: `, JSON.stringify(event, null, 2));

        const recipient = event.recipient;
        const useCase = event.useCase;
        const agentRuntimeArn = useCase.agentRuntimeArn;
        const sessionId = event.sessionVariables.sessionId;

        // Derive runtimeUserId: actor-id-{phoneNumberWithoutPlus}
        const phoneNumberWithoutPlus = recipient.destinationAddress.replace(/^\+/, '');
        const runtimeUserId = `actor-id-${phoneNumberWithoutPlus}`;

        // Build payload with prompt and phone_number
        const payload = {
            prompt: recipient.messageBody,
            phone_number: recipient.destinationAddress
        };

        // Build InvokeAgentRuntimeCommand input
        const commandInput = {
            agentRuntimeArn: agentRuntimeArn,
            runtimeSessionId: sessionId,
            runtimeUserId: runtimeUserId,
            contentType: "application/json",
            payload: Buffer.from(JSON.stringify(payload))
        };

        console.trace(`AgentCore command input: `, JSON.stringify(commandInput, null, 2));

        const client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION });
        const command = new InvokeAgentRuntimeCommand(commandInput);
        const agentResponse = await client.send(command);

        // Parse response
        const rawResponse = await agentResponse.response.transformToString();
        let response;

        try {
            const parsed = JSON.parse(rawResponse);
            if (parsed.content && Array.isArray(parsed.content)) {
                const textBlocks = parsed.content
                    .filter(block => block.type === 'text' || (block.text !== undefined && block.type !== 'thinking'))
                    .map(block => block.text);
                response = textBlocks.join('\n');
            } else {
                response = rawResponse;
            }
        } catch (_) {
            response = rawResponse;
        }

        // Strip any <thinking> tags that may have leaked through
        response = response.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim();

        console.trace('agentResponse: ', response);

        callback(null, { llmSessionId: sessionId, response: response, source: 'Bedrock AgentCore Runtime' });
    } catch (error) {
        console.error(`AgentCore Runtime error - agentRuntimeArn: ${event?.useCase?.agentRuntimeArn}, sessionId: ${event?.sessionVariables?.sessionId}`, error);
        callback(error);
    }
};

export default { handler };
