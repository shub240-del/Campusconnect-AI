// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import BedrockService from '../services/BedrockService.mjs';
import Utilities from '../services/UtilitiesService.mjs';

export const handler = async (event, _context, callback) => {
    try {
        console.info("App Version:", process.env.APPLICATION_VERSION);
        console.trace(`Event: `, JSON.stringify(event, null, 2));

        const recipient = event.recipient;
        const conversation = event.conversation;
        const useCase = event.useCase;
        let kbSessionId = event.sessionVariables?.kbSessionId;

        const retrieveResponse = await BedrockService.retrieveAndGenerate(recipient.messageBody, useCase, kbSessionId);
        console.trace(1);
        console.trace(retrieveResponse);

        let response = `I'm sorry, I couldn't find an answer based on the information available to me.`;
        let source = 'Bedrock Knowledge Base';

        if (retrieveResponse.citations?.[0]?.retrievedReferences?.length) {
            response = retrieveResponse.output.text;
        } else {
            console.trace(2);
            const isAmazonModel = useCase.modelId?.includes('amazon');
            if (isAmazonModel) {
                const formattedConversation = Utilities.formatAmazonConversation(conversation || []);
                formattedConversation.push({ "role": "user", "content": [{ "text": recipient.messageBody }] });

                const request = {
                    modelId: useCase.modelId,
                    messages: formattedConversation,
                    inferenceConfig: {
                        "maxTokens": parseInt(useCase.llmMaxTokens),
                        "temperature": parseFloat(useCase.llmTemperature),
                    },
                };

                source = "Amazon LLM";
                response = await BedrockService.converse(request, useCase);
                console.trace(response);
            } else {
                console.trace(3);
                const formattedConversation = Utilities.formatAnthropicConversation(conversation || []);
                formattedConversation.push({ "role": "user", "content": recipient.messageBody });

                const promptEnvelope = {
                    "messages": formattedConversation,
                    "anthropic_version": "bedrock-2023-05-31",
                    "max_tokens": parseInt(useCase.llmMaxTokens),
                    "temperature": parseFloat(useCase.llmTemperature)
                };

                source = "Anthropic LLM";
                const parsedResponse = await BedrockService.invokeModel(promptEnvelope, useCase);
                console.trace(parsedResponse);
                response = parsedResponse.content[0].text;
            }
        }

        if (!kbSessionId) kbSessionId = retrieveResponse.kbSessionId;

        callback(null, { 'llmSessionId': kbSessionId, 'response': response, 'source': source });
    } catch (error) {
        console.error(error);
        callback(error);
    }
};

export default { handler };