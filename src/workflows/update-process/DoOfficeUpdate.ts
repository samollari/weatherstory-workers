import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { RESTPostAPIChannelMessageJSONBody } from 'discord-api-types/v10';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { basename } from 'path/posix';
import { StartParams } from './StartUpdate';
import { Env } from '../../env';
import { officePageURL, officeMessageKey } from '../../util/offices';
import { htmlQuery } from '../../util/htmlquery';
import { PagePath, WSType } from '../lifecycle';

export class WXStoryPerOfficeWorkflow extends WorkflowEntrypoint<Env, OfficeParams> {
	async run(event: Readonly<WorkflowEvent<OfficeParams>>, step: WorkflowStep) {
		const pageType = await step.do('Get page type', async () => {
			const { officeId } = event.payload;
			const statement = this.env.DB.prepare('SELECT PageRelativePath, StoryType FROM Offices WHERE OfficeId = ?');
			const { results } = await statement.bind(officeId).run<{ PageRelativePath: PagePath | null; StoryType: WSType | null }>();
			return results[0];
		});

		if (pageType.StoryType !== WSType.Tabs || pageType.PageRelativePath === null) {
			return;
		}

		// TODO: Support multiple tabs/stories
		const pageContent = await step.do('Fetch WX Story page content', async () => {
			const { office } = event.payload;
			const response = await fetch(officePageURL(office, pageType.PageRelativePath!), {
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
						url: officePageURL(office, pageType.PageRelativePath!).toString(),
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
				WHERE OfficeId = ?1 AND (?2 = 0 OR dev = 1);
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

export type OfficeParams = {
	office: string;
	officeId: number;
} & StartParams;
