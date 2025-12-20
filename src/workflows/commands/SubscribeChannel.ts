import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { Routes, RESTPatchAPIWebhookWithTokenMessageJSONBody } from 'discord-api-types/v10';
import { Env } from '../../env';
import { RESTAPI } from '../../util/interaction-helpers';

export class SubscribeChannelWorkflow extends WorkflowEntrypoint<Env, SubscribeParams> {
	async run(event: Readonly<WorkflowEvent<SubscribeParams>>, step: WorkflowStep) {
		const alreadySubscribed = await step.do('Check if this subscription already exists', async () => {
			const { office, channel } = event.payload;

			const statement = this.env.DB.prepare(`
				SELECT id FROM Subscriptions
				WHERE
					OfficeId = (SELECT OfficeId FROM Offices WHERE CallSign = ?1)
					AND ChannelId = ?2;
			`);

			const { results } = await statement.bind(office.toUpperCase(), channel).run<{ id: number }>();

			return results.length > 0;
		});

		if (alreadySubscribed) {
			await step.do('Acknowledge already subscribed', async () => {
				await RESTAPI.getInstance(this.env.DISCORD_BOT_TOKEN).patch(Routes.webhookMessage(this.env.DISCORD_APP_ID, event.payload.token), {
					body: {
						content: `<#${event.payload.channel}> is already subscribed to updates from office ${event.payload.office}`,
					} satisfies RESTPatchAPIWebhookWithTokenMessageJSONBody,
				});
			});
		} else {
			try {
				await step.do('Create subscription in database', async () => {
					const { office, guild, channel } = event.payload;
					console.log(`Subscribing channel ${channel} (in guild ${guild}) to office ${office}`);

					const statement = this.env.DB.prepare(`
						INSERT INTO Subscriptions (OfficeId, GuildId, ChannelId)
						VALUES (
							(SELECT OfficeId FROM Offices WHERE CallSign = ?1)
						, ?2, ?3)
						RETURNING id;
					`);

					const { results } = await statement.bind(office.toUpperCase(), guild, channel).run<{ id: number }>();

					return results[0].id;
				});
			} catch (e) {
				console.error(e);

				await step.do('Acknowledge subscription failure', async () => {
					await RESTAPI.getInstance(this.env.DISCORD_BOT_TOKEN).patch(Routes.webhookMessage(this.env.DISCORD_APP_ID, event.payload.token), {
						body: {
							content: `**Could not subscribe <#${event.payload.channel}> to updates from office ${event.payload.office}!**`,
						} satisfies RESTPatchAPIWebhookWithTokenMessageJSONBody,
					});
				});

				return;
			}

			await step.do('Acknowledge subscription success', async () => {
				await RESTAPI.getInstance(this.env.DISCORD_BOT_TOKEN).patch(Routes.webhookMessage(this.env.DISCORD_APP_ID, event.payload.token), {
					body: {
						content: `Successfully subscribed <#${event.payload.channel}> to updates from office ${event.payload.office}`,
					} satisfies RESTPatchAPIWebhookWithTokenMessageJSONBody,
				});
			});
		}

		const officeId = await step.do('Get Office ID for further steps', async () => {
			const { office } = event.payload;
			const statement = this.env.DB.prepare(`SELECT OfficeId FROM Offices WHERE CallSign = ?`);
			const { results } = await statement.bind(office.toUpperCase()).run<{ OfficeId: number }>();
			return results[0].OfficeId;
		});

		const isFirstSubscription = await step.do('Get count of subscriptions to this office', async () => {
			const statement = this.env.DB.prepare(`SELECT COUNT(id) FROM Subscriptions WHERE OfficeId = ?`);
			const { results } = await statement.bind(officeId).run<{ 'COUNT(id)': number }>();
			return results[0]['COUNT(id)'] == 1;
		});

		if (isFirstSubscription) {
			await step.do('Run update for this office to send current weather story', async () => {
				await this.env.WX_STORY_PER_OFFICE_WORKFLOW.create({
					params: {
						office: event.payload.office.toLowerCase(),
						officeId,
						dev: false,
					},
				});
			});
		} else {
			await step.do('Send current weather story to channel', async () => {
				await this.env.SENDMESSAGE_WORKFLOW.create({
					params: {
						office: event.payload.office.toLowerCase(),
						channel: event.payload.channel,
					},
				});
			});
		}
	}
}
export type SubscribeParams = {
	office: string;
	guild?: string;
	channel: string;
	/** Interaction continuation token */
	token: string;
};
