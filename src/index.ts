// <docs-tag name="full-workflow-example">
import un from '@nrsk/unindent';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { basename } from 'node:path/posix';

type Env = {
	// Add your bindings here, e.g. Workers KV, D1, Workers AI, etc.
	START_WX_STORY_UPDATE_WORKFLOW: Workflow<StartParams>;
	WX_STORY_PER_OFFICE_WORKFLOW: Workflow<OfficeParams>;
	OFFICES_LAST_MODIFIED_TIMES: KVNamespace;
	wxstory_images: R2Bucket;
	DB: D1Database;
	R2_BUCKET_BASE: string;
	USER_AGENT: string;
};

// User-defined params passed to your workflow
type StartParams = {
	force: boolean;
};

type OfficeParams = {
	office: string;
	officeId: number;
} & StartParams;

function officePrimaryImageURL(office: string): URL {
	return new URL(`https://www.weather.gov/images/${office}/WxStory/WeatherStory1.png`);
}

function officePageURL(office: string): URL {
	return new URL(`https://www.weather.gov/${office}/weatherstory`);
}

async function htmlQuery<Queries extends Record<string, string>>(html: BodyInit, queries: Queries) {
	const queryResponses: { [key: string]: string[] } = {};

	let rewriter = new HTMLRewriter();
	for (const entry of Object.entries(queries)) {
		const [key, query] = entry;
		const thisQueryResponses: (typeof queryResponses)[keyof typeof queryResponses] = (queryResponses[key] = []);

		rewriter = rewriter.on(query, {
			comments() {},
			element(element) {
				thisQueryResponses.push('');
			},
			text(element) {
				// debugger;
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

	const tempResponseToTransform = new Response(html);

	const transformedResponse = rewriter.transform(tempResponseToTransform);

	await transformedResponse.text();

	return queryResponses as Record<keyof Queries, string[]>;
}

// <docs-tag name="workflow-entrypoint">
export class StartWXStoryUpdateWorkflow extends WorkflowEntrypoint<Env, StartParams> {
	async run(event: WorkflowEvent<StartParams>, step: WorkflowStep) {
		// 1. Find all NWS offices to poll (temp: hardcode. eventually: query D1)
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

		// 2. Start a workflow for each office
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
		// 1. Fetch last-modified header for the primary story image
		const modifiedTimestamp = await step.do('Fetch last-modified header for the primary story image', async () => {
			const { office } = event.payload;

			const primaryImageURL = officePrimaryImageURL(office);
			const response = await fetch(primaryImageURL, {
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

		// 2. Check if the image was modified (compare against D1)
		const wasModified = await step.do('Check if image was modified since last run', async () => {
			const { office } = event.payload;

			const lastModified = await this.env.OFFICES_LAST_MODIFIED_TIMES.get(office);

			const continueProcessing = event.payload.force || lastModified !== modifiedTimestamp;
			if (continueProcessing) {
				await this.env.OFFICES_LAST_MODIFIED_TIMES.put(office, modifiedTimestamp);
			}
			return continueProcessing;
		});
		console.log({ wasModified });

		if (!wasModified) {
			// Short circuit, do not continue execution
			return;
		}

		// 3. Fetch image data and cache it in R2
		const cachedAddress = await step.do('Cache modified images', async () => {
			const { office } = event.payload;

			const imageAddress = officePrimaryImageURL(office);
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
			if (event.payload.force) {
				imageURL.searchParams.set('v', new Date().getTime().toString());
			}

			return imageURL.toString();
		});
		console.log({ cachedAddress });

		// 4. Fetch page content
		const pageContent = await step.do('Fetch WX Story page content', async () => {
			const { office } = event.payload;
			const response = await fetch(officePageURL(office), {
				headers: {
					'User-Agent': 'WXStory Workers Bot - sam@gizm0.dev',
				},
			});
			if (!response.ok) {
				throw new Error(`WX Story page fetch failed`);
			}

			return await response.text();
		});
		console.log({ pageContent });

		// 5. Parse story title and description from page
		const storyDetails = await step.do('Parse story title and description', async () => {
			const queryResults = await htmlQuery(pageContent, {
				title: 'div.c-tabs-nav__link:nth-child(1) > span:nth-child(1)',
				description: 'div.c-tab:nth-child(2) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)',
			});

			return {
				title: queryResults.title[0],
				description: queryResults.description[0],
			};
		});
		console.log({ storyDetails });

		// 6. Assemble message data (story title, description, change timestamp, R2 image URL)
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

		// 7. Lookup all channels to send to
		const officeWebhooks = await step.do('Lookup office channels', async () => {
			const statement = this.env.DB.prepare(`SELECT WebhookURL FROM Subscriptions WHERE OfficeId = ?;`);
			const { officeId } = event.payload;

			const { results } = await statement.bind(officeId).run<{ WebhookURL: string }>();
			return results.map(({ WebhookURL }) => WebhookURL);
		});

		// 8. Send messages to channels
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

// <docs-tag name="workflows-fetch-handler">
export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		let url = new URL(req.url);

		if (url.pathname.startsWith('/favicon')) {
			return Response.json({}, { status: 404 });
		}

		// Get the status of an existing instance, if provided
		// GET /?instanceId=<id here>
		let id = url.searchParams.get('instanceId');
		if (id) {
			let instance = await env.START_WX_STORY_UPDATE_WORKFLOW.get(id);
			return Response.json({
				status: await instance.status(),
			});
		}

		const force = url.searchParams.has('force');

		// Spawn a new instance and return the ID and status
		let instance = await env.START_WX_STORY_UPDATE_WORKFLOW.create({ params: { force } });
		// You can also set the ID to match an ID in your own system
		// and pass an optional payload to the Workflow
		// let instance = await env.MY_WORKFLOW.create({
		// 	id: 'id-from-your-system',
		// 	params: { payload: 'to send' },
		// });
		return Response.json({
			id: instance.id,
			details: await instance.status(),
			force,
		});
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		await env.START_WX_STORY_UPDATE_WORKFLOW.create();
	},
};
// </docs-tag name="workflows-fetch-handler">
// </docs-tag name="full-workflow-example">
