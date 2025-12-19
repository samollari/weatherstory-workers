import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { RESTPostAPIChannelMessageJSONBody, Routes } from 'discord-api-types/v10';
import { Env } from '../../env';
import { officeMessageKey } from '../../util/offices';
import { RESTAPI } from '../../interaction';

export class SendMessageWorkflow extends WorkflowEntrypoint<Env, SendMessageParams> {
	async run(event: Readonly<WorkflowEvent<SendMessageParams>>, step: WorkflowStep) {
		const messageData = await step.do('Retreive message data from KV', async () => {
			return await this.env.wxstory_kv.get<RESTPostAPIChannelMessageJSONBody>(officeMessageKey(event.payload.office.toLowerCase()), 'json');
		});

		if (!messageData) {
			console.warn('Failed to get message data - returned null');
			return;
		}

		await step.do('Send message', async () => {
			await RESTAPI.getInstance(this.env.DISCORD_BOT_TOKEN).post(Routes.channelMessages(event.payload.channel), {
				body: messageData,
			});
		});
	}
}

export type SendMessageParams = {
	office: string;
	channel: string;
};
