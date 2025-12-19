import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { Routes, RESTPatchAPIWebhookWithTokenMessageJSONBody } from 'discord-api-types/v10';
import { Env } from '../../env';
import { RESTAPI } from '../../interaction';

export class UnsubscribeChannelWorkflow extends WorkflowEntrypoint<Env, UnsubscribeParams> {
	async run(event: Readonly<WorkflowEvent<UnsubscribeParams>>, step: WorkflowStep) {
		let subscriptionsRemoved: number;
		try {
			subscriptionsRemoved = await step.do('Remove subscription from database', async () => {
				const { office, channel } = event.payload;

				if (office) {
					const statement = this.env.DB.prepare(`
						DELETE FROM Subscriptions
						WHERE
							ChannelId = ?1
							AND OfficeId = (
								SELECT OfficeId FROM Offices
								WHERE CallSign = ?2
							)
						RETURNING *;
					`);

					const { results } = await statement.bind(channel, office).run();

					return results.length;
				} else {
					const statement = this.env.DB.prepare(`
						DELETE FROM Subscriptions
						WHERE ChannelId = ?1
						RETURNING *;
					`);

					const { results } = await statement.bind(channel).run();

					return results.length;
				}
			});
		} catch (e) {
			console.error(e);

			await step.do('Acknowledge unsubscribe failure', async () => {
				await RESTAPI.getInstance(this.env.DISCORD_BOT_TOKEN).patch(Routes.webhookMessage(this.env.DISCORD_APP_ID, event.payload.token), {
					body: {
						content: `**Could not unsubscribe <#${event.payload.channel}> from updates!**`,
					} satisfies RESTPatchAPIWebhookWithTokenMessageJSONBody,
				});
			});

			throw e;
		}

		await step.do('Acknowledge unsubscribe success', async () => {
			const { office } = event.payload;
			await RESTAPI.getInstance(this.env.DISCORD_BOT_TOKEN).patch(Routes.webhookMessage(this.env.DISCORD_APP_ID, event.payload.token), {
				body: {
					content: `Successfully unsubscribed <#${event.payload.channel}> from updates ${
						office ? `from ${office}` : `from ${subscriptionsRemoved} office${subscriptionsRemoved === 1 ? '' : 's'}`
					}`,
				} satisfies RESTPatchAPIWebhookWithTokenMessageJSONBody,
			});
		});
	}
}
export type UnsubscribeParams = {
	office?: string;
	channel: string;
	/** Interaction continuation token */
	token: string;
};
