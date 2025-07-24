// <docs-tag name="full-workflow-example">
import un from '@nrsk/unindent';
import { Router } from '@tsndr/cloudflare-worker-router';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { basename } from 'node:path/posix';
import { verifyKey } from 'discord-interactions';
import {
	APIChatInputApplicationCommandInteraction,
	APIInteraction,
	ApplicationCommandType,
	InteractionResponseType,
	InteractionType,
} from 'discord-api-types/payloads';
import { RESTPatchAPIWebhookWithTokenMessageJSONBody, RESTPostAPIChannelMessageJSONBody, Routes } from 'discord-api-types/v10';
import { commands, deploy, RESTAPI } from './interaction';
import { NodeHtmlMarkdown } from 'node-html-markdown';

export type Env = {
	START_WX_STORY_UPDATE_WORKFLOW: Workflow<StartParams>;
	WX_STORY_PER_OFFICE_WORKFLOW: Workflow<OfficeParams>;
	SENDMESSAGE_WORKFLOW: Workflow<SendMessageParams>;
	SUBSCRIBE_WORKFLOW: Workflow<SubscribeParams>;
	UNSUBSCRIBE_WORKFLOW: Workflow<UnsubscribeParams>;

	wxstory_kv: KVNamespace;
	wxstory_images: R2Bucket;
	DB: D1Database;

	// Environment Variables
	R2_BUCKET_BASE: string;
	USER_AGENT: string;

	// Secrets
	DISCORD_APP_ID: string;
	DISCORD_PUBLIC_KEY: string;
	DISCORD_BOT_TOKEN: string;
};

// User-defined params passed to your workflow
type StartParams = {
	dev: boolean;
};

type OfficeParams = {
	office: string;
	officeId: number;
} & StartParams;

type SendMessageParams = {
	office: string;
	channel: string;
};

type SubscribeParams = {
	office: string;
	guild?: string;
	channel: string;
	/** Interaction continuation token */
	token: string;
};

type UnsubscribeParams = {
	office?: string;
	channel: string;
	/** Interaction continuation token */
	token: string;
};

function officePageURL(office: string): URL {
	return new URL(`https://www.weather.gov/${office}/weatherstory`);
}

function officeMessageKey(office: string) {
	return `${office}-message` as const;
}

async function htmlQuery<Queries extends Record<string, { query: string; attribute?: string }>>(html: BodyInit, queries: Queries) {
	const queryResponses: { [key: string]: string[] } = {};

	let rewriter = new HTMLRewriter();
	for (const entry of Object.entries(queries)) {
		const [key, query] = entry;
		const queryAttribute = query.attribute;
		const thisQueryResponses: (typeof queryResponses)[keyof typeof queryResponses] = (queryResponses[key] = []);

		if (queryAttribute) {
			rewriter = rewriter.on(query.query, {
				element(element) {
					const attributeValue = element.getAttribute(queryAttribute);
					if (!attributeValue) {
						return;
					}
					thisQueryResponses.push(attributeValue);
				},
			});
		} else {
			rewriter = rewriter.on(query.query, {
				element(element) {
					thisQueryResponses.push('');
				},
				text(element) {
					const lastIndex = thisQueryResponses.length - 1;
					thisQueryResponses[lastIndex] += element.text;
					if (element.lastInTextNode) {
						thisQueryResponses[lastIndex] = un(thisQueryResponses[lastIndex]);
						const matches = /(.*\S)\s*/s.exec(thisQueryResponses[lastIndex]);
						if (matches) {
							thisQueryResponses[lastIndex] = matches[1];
						}
					}
				},
			});
		}
	}

	const tempResponseToTransform = new Response(html);

	const transformedResponse = rewriter.transform(tempResponseToTransform);

	await transformedResponse.text();

	return queryResponses as Record<keyof Queries, string[]>;
}

// <docs-tag name="workflow-entrypoint">
export class StartWXStoryUpdateWorkflow extends WorkflowEntrypoint<Env, StartParams> {
	async run(event: WorkflowEvent<StartParams>, step: WorkflowStep) {
		const offices = await step.do('Collect offices to poll', async () => {
			const statement = this.env.DB.prepare(`
				SELECT CallSign, OfficeId FROM (
					SELECT OfficeId, COUNT(OfficeId) AS InstanceCount, CallSign FROM Offices
					INNER JOIN Subscriptions USING (OfficeId)
					GROUP BY OfficeId
				)
				WHERE InstanceCount > 0;
			`);
			const { results } = await statement.run<{ CallSign: string; OfficeId: number }>();
			console.log({ results });
			return results.map(({ CallSign, OfficeId }) => ({ office: CallSign.toLowerCase(), officeId: OfficeId }));
		});
		console.log({ offices });

		if (offices.length === 0) {
			return;
		}

		await step.do('Start per-office workflows', async () => {
			let instances = await this.env.WX_STORY_PER_OFFICE_WORKFLOW.createBatch(
				offices.map((office) => ({
					params: {
						...event.payload,
						...office,
					},
				}))
			);
		});
	}
}
// </docs-tag name="workflow-entrypoint">

export class WXStoryPerOfficeWorkflow extends WorkflowEntrypoint<Env, OfficeParams> {
	async run(event: Readonly<WorkflowEvent<OfficeParams>>, step: WorkflowStep) {
		// TODO: Support multiple tabs/stories

		const pageContent = await step.do('Fetch WX Story page content', async () => {
			const { office } = event.payload;
			const response = await fetch(officePageURL(office), {
				headers: {
					'User-Agent': this.env.USER_AGENT,
				},
			});
			if (!response.ok) {
				throw new Error(`WX Story page fetch failed`);
			}

			return await response.text();
		});
		console.log({ pageContent });

		const storyDetails = await step.do('Parse story title, description, and image URL', async () => {
			const queryResults = await htmlQuery(pageContent, {
				title: { query: 'div.c-tabs-nav__link:nth-child(1) > span:nth-child(1)' },
				description: { query: 'div.c-tab:nth-child(2) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)' },
				imageURL: {
					query: 'div.c-tab:nth-child(2) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > img:nth-child(1)',
					attribute: 'src',
				},
			});

			const nhm = new NodeHtmlMarkdown();

			return {
				title: nhm.translate(queryResults.title[0]),
				description: nhm.translate(queryResults.description[0]),
				imageURL: queryResults.imageURL[0],
			};
		});
		console.log({ storyDetails });

		const modifiedTimestamp = await step.do('Fetch last-modified header for the primary story image', async () => {
			const response = await fetch(storyDetails.imageURL, {
				method: 'HEAD',
				headers: {
					'User-Agent': this.env.USER_AGENT,
				},
			});
			if (!response.ok) {
				throw new Error(`Image HEAD fetch failed`);
			}

			const modifiedString = response.headers.get('last-modified');
			if (modifiedString === null) {
				throw new Error(`Image headers did not contain last-modified header`);
			}

			return new Date(modifiedString).toISOString();
		});
		console.log({ modifiedTimestamp });

		const imageURLChanged = await step.do('Compare image URL with value stored in KV and update if it changed', async () => {
			const { office } = event.payload;
			const imageURL = storyDetails.imageURL;

			const imageURLKey = `${office}-imageurl`;

			const lastImageURL = await this.env.wxstory_kv.get(imageURLKey);

			const changed = imageURL !== lastImageURL;

			if (changed) {
				await this.env.wxstory_kv.put(imageURLKey, imageURL);
			}

			return changed;
		});
		console.log({ imageURLChanged });

		const wasModified = await step.do('Compare modified timestamp with value stored in KV and update if it changed', async () => {
			const { office } = event.payload;
			const timestampKey = `${office}-modified`;

			const lastModified = await this.env.wxstory_kv.get(timestampKey);

			const continueProcessing = lastModified !== modifiedTimestamp;
			if (continueProcessing) {
				await this.env.wxstory_kv.put(timestampKey, modifiedTimestamp);
			}
			return continueProcessing;
		});
		console.log({ wasModified });

		// If the URL did not change and the image was not modified and not running a dev update, do not continue
		// If the URL changed or the image was modified or running a dev update, continue
		if (!event.payload.dev && !imageURLChanged && !wasModified) {
			// Short circuit, do not continue execution
			return;
		}

		const cachedAddress = await step.do('Cache modified images', async () => {
			const { office } = event.payload;

			const imageAddress = new URL(storyDetails.imageURL);
			const response = await fetch(imageAddress, {
				headers: {
					'User-Agent': this.env.USER_AGENT,
				},
			});
			if (!response.ok) {
				throw new Error(`Image fetch for cache failed`);
			}

			const imageCacheKey = `${office}/${new Date(modifiedTimestamp).getTime() / 1000}/${basename(imageAddress.pathname)}`;

			const storedObject = await this.env.wxstory_images.put(imageCacheKey, response.body);

			if (!storedObject) {
				throw new Error('Could not put cached image!');
			}

			const imageURL = new URL(storedObject.key, this.env.R2_BUCKET_BASE);
			if (event.payload.dev) {
				imageURL.searchParams.set('v', new Date().getTime().toString());
			}

			return imageURL.toString();
		});
		console.log({ cachedAddress });

		const officeMessageData = await step.do('Assemble message data', async () => {
			const { office } = event.payload;

			return {
				embeds: [
					{
						author: {
							name: `${office.toUpperCase()} Weather Story`,
							icon_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/79/NOAA_logo.svg/240px-NOAA_logo.svg.png',
						},
						title: storyDetails.title,
						description: storyDetails.description,
						url: officePageURL(office).toString(),
						timestamp: modifiedTimestamp,
						color: 0x135897,
						image: {
							url: cachedAddress,
						},
					},
				],
			} satisfies RESTPostAPIChannelMessageJSONBody;
		});
		console.log({ officeMessageData });

		await step.do('Cache message data in KV', async () => {
			const { office } = event.payload;
			await this.env.wxstory_kv.put(officeMessageKey(office), JSON.stringify(officeMessageData));
		});

		const officeChannels = await step.do('Lookup office channels', async () => {
			const statement = this.env.DB.prepare(`
				SELECT ChannelId
				FROM Subscriptions
				WHERE OfficeId = ? AND (? = 0 OR dev = 1);
			`); // If not dev run, picks any matching the office. If dev run, only selects dev channels
			const { officeId } = event.payload;

			const { results } = await statement.bind(officeId, event.payload.dev ?? false).run<{ ChannelId: string }>();
			return results.map(({ ChannelId }) => ChannelId);
		});

		await step.do('Send messages', async () => {
			await this.env.SENDMESSAGE_WORKFLOW.createBatch(
				officeChannels.map((channel) => ({
					params: {
						office: event.payload.office,
						channel,
					},
				}))
			);
		});
	}
}

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

			const { results } = await statement.bind(office, channel).run<{ id: number }>();

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

					const statement = this.env.DB.prepare(`
						INSERT INTO Subscriptions (OfficeId, GuildId, ChannelId)
						VALUES (
							(SELECT OfficeId FROM Offices WHERE CallSign = ?1)
						, ?2, ?3)
						RETURNING id;
					`);

					const { results } = await statement.bind(office, guild, channel).run<{ id: number }>();

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

				throw e;
			}

			await step.do('Acknowledge subscription success', async () => {
				await RESTAPI.getInstance(this.env.DISCORD_BOT_TOKEN).patch(Routes.webhookMessage(this.env.DISCORD_APP_ID, event.payload.token), {
					body: {
						content: `Successfully subscribed <#${event.payload.channel}> to updates from office ${event.payload.office}`,
					} satisfies RESTPatchAPIWebhookWithTokenMessageJSONBody,
				});
			});
		}

		// TODO: If this is the first subscription to this office, run a manual update

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

const router = new Router<Env>();

router.get('/status', async ({ req, env }) => {
	const id = req.query['instanceId'];
	let instance = await env.START_WX_STORY_UPDATE_WORKFLOW.get(id);
	return Response.json({
		status: await instance.status(),
	});
});

router.any('/invoke', async ({ req, env }) => {
	const dev = 'dev' in req.query;

	// Spawn a new instance and return the ID and status
	let instance = await env.START_WX_STORY_UPDATE_WORKFLOW.create({ params: { dev } });
	// You can also set the ID to match an ID in your own system
	// and pass an optional payload to the Workflow
	// let instance = await env.MY_WORKFLOW.create({
	// 	id: 'id-from-your-system',
	// 	params: { payload: 'to send' },
	// });
	return Response.json({
		id: instance.id,
		details: await instance.status(),
		force: dev,
	});
});

router.any('/deploy', async ({ env }) => {
	await deploy(env);
	return new Response('ok');
});

router.post('/interaction', async ({ req, env }) => {
	const signature = req.headers.get('X-Signature-Ed25519');
	const timestamp = req.headers.get('X-Signature-Timestamp');
	if (!signature || !timestamp) {
		return new Response('Missing required headers', { status: 400 });
	}
	const rawBody = await req.raw.clone().arrayBuffer();
	const isValidRequest = await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
	if (!isValidRequest) {
		return new Response('Bad request signature', { status: 401 });
	}

	const message = (await req.raw.json()) as APIInteraction;
	console.log({ message });

	if (message.type === InteractionType.Ping) {
		return Response.json({
			type: InteractionResponseType.Pong,
		});
	}

	if (message.type === InteractionType.ApplicationCommand) {
		if (message.data.type !== ApplicationCommandType.ChatInput) {
			return Response.json({ error: 'Unsupported command type' }, { status: 400 });
		}

		const receivedCommandName = message.data.name;

		if (!(receivedCommandName in commands.global)) {
			return Response.json({ error: 'Unknown command' }, { status: 400 });
		}

		const command = commands.global[receivedCommandName as keyof typeof commands.global];

		return await command.run(env, message as APIChatInputApplicationCommandInteraction);
	}

	console.error('Unknown interaction type');
	return Response.json({ error: 'Unknown interaction type' }, { status: 400 });
});

// <docs-tag name="workflows-fetch-handler">
export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		return router.handle(req, env);
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		await env.START_WX_STORY_UPDATE_WORKFLOW.create({ params: { dev: false } });
	},
};
// </docs-tag name="workflows-fetch-handler">
// </docs-tag name="full-workflow-example">
