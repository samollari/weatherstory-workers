// <docs-tag name="full-workflow-example">
import un from '@nrsk/unindent';
import { Router } from '@tsndr/cloudflare-worker-router';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { basename } from 'node:path/posix';

type Env = {
	// Add your bindings here, e.g. Workers KV, D1, Workers AI, etc.
	START_WX_STORY_UPDATE_WORKFLOW: Workflow<StartParams>;
	WX_STORY_PER_OFFICE_WORKFLOW: Workflow<OfficeParams>;
	wxstory_kv: KVNamespace;
	wxstory_images: R2Bucket;
	DB: D1Database;
	R2_BUCKET_BASE: string;
	USER_AGENT: string;
};

// User-defined params passed to your workflow
type StartParams = {
	dev: boolean;
};

type OfficeParams = {
	office: string;
	officeId: number;
} & StartParams;

function officePageURL(office: string): URL {
	return new URL(`https://www.weather.gov/${office}/weatherstory`);
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

			return {
				title: queryResults.title[0],
				description: queryResults.description[0],
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
				username: `${office.toUpperCase()} Weather Story`,
				avatar_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/79/NOAA_logo.svg/240px-NOAA_logo.svg.png',
				embeds: [
					{
						...storyDetails,
						url: officePageURL(office).toString(),
						timestamp: modifiedTimestamp,
						color: 0x135897,
						image: {
							url: cachedAddress,
						},
					},
				],
			};
		});
		console.log({ officeMessageData });

		await step.do('Cache message data in KV', async () => {
			const { office } = event.payload;
			const messageKey = `${office}-message`;
			await this.env.wxstory_kv.put(messageKey, JSON.stringify(officeMessageData));
		});

		const officeWebhooks = await step.do('Lookup office channels', async () => {
			const statement = this.env.DB.prepare(`
				SELECT WebhookURL
				FROM Subscriptions
				WHERE OfficeId = ? AND (? = 0 OR dev = 1);
			`); // If not dev run, picks any matching the office. If dev run, only selects dev channels
			const { officeId } = event.payload;

			const { results } = await statement.bind(officeId, event.payload.dev).run<{ WebhookURL: string }>();
			return results.map(({ WebhookURL }) => WebhookURL);
		});

		await step.do('Send messages', async () => {
			await Promise.all(
				officeWebhooks.map((webhook) =>
					step.do(`Call webhook ${webhook.substring(webhook.length - 10)}`, async () => {
						await fetch(webhook, {
							method: 'POST',
							body: JSON.stringify(officeMessageData),
							headers: {
								'Content-Type': 'application/json',
							},
						});
					})
				)
			);
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

// <docs-tag name="workflows-fetch-handler">
export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		return router.handle(req, env);
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		await env.START_WX_STORY_UPDATE_WORKFLOW.create();
	},
};
// </docs-tag name="workflows-fetch-handler">
// </docs-tag name="full-workflow-example">
