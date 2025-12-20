import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NWS_OFFICES, Office, uppercaseOffice } from '../../util/offices';
import { Env } from '../../env';
import { deploy } from '../../interaction';
import { htmlQuery } from '../../util/htmlquery';

export class DeployWorkflow extends WorkflowEntrypoint<Env, DeployParams> {
	async run(event: Readonly<WorkflowEvent<DeployParams>>, step: WorkflowStep): Promise<void> {
		const offices = await step.do('Collect offices for this run', async () =>
			event.payload.limit !== undefined ? NWS_OFFICES.slice(0, event.payload.limit) : NWS_OFFICES
		);
		const [officesUsingWxStoryPage, officesNotUsingWxStoryPage] = await step.do('Determine whether offices use WX Story page', async () => {
			const officesUseWxStoryPage = await Promise.all(
				offices.map(
					async (office) =>
						[
							office,
							await step.do(`Fetch weatherstory page for office ${office}`, async () => {
								const response = await fetch(`https://www.weather.gov/${office}/weatherstory`, {
									headers: {
										'User-Agent': this.env.USER_AGENT,
									},
									method: 'HEAD',
								});
								if (!response.ok && response.status != 404) {
									console.error(response.status, response.statusText, await response.text());
								}
								return response.ok;
							}),
						] as const
				)
			);

			const officesUsingWxStoryPage: Office[] = [],
				officesNotUsingWxStoryPage: Office[] = [];

			for (const [office, usingWxStoryPage] of officesUseWxStoryPage) {
				if (usingWxStoryPage) {
					officesUsingWxStoryPage.push(office);
				} else {
					officesNotUsingWxStoryPage.push(office);
				}
			}

			return [officesUsingWxStoryPage, officesNotUsingWxStoryPage];
		});

		const officeHomePageStoryMethod = await step.do(
			'Determine where on the home page WX Story is for offices that do not use a discrete page',
			async () => {
				const homePageMethods = await Promise.all(
					officesNotUsingWxStoryPage.map(
						async (office) =>
							[
								office,
								await step.do(`Determine home page WX Story method for office ${office}`, async () => {
									const response = await fetch(`https://www.weather.gov/${office}`, {
										headers: {
											'User-Agent': this.env.USER_AGENT,
										},
									});
									if (!response.ok || !response.body) {
										console.error(response.status, response.statusText, await response.text());
										return 'unsure';
									}

									const queryResults = await htmlQuery(response.body, {
										table: { query: '#WStable' },
										graphicast: { query: '#tabs .graphicast' },
										// image: { query: 'img', attribute: 'src' },
									});

									if (queryResults.table.length != 0) {
										return 'wstable';
									}

									if (queryResults.graphicast.length != 0) {
										return 'tabs';
									}

									// if (queryResults.image.some((v) => v.toLowerCase().includes('weatherstory'))) {
									// 	return 'image';
									// }
									return 'unsure';
								}),
							] as const
					)
				);

				const officeMethods: {
					[key in (typeof homePageMethods)[number][1]]: Office[];
				} = {
					unsure: [],
					wstable: [],
					tabs: [],
					// image: []
				};

				for (const [office, method] of homePageMethods) {
					officeMethods[method].push(office);
				}

				return officeMethods;
			}
		);

		const dbQueryValues = await step.do(
			'Collect query values for methods',
			async () =>
				[
					...officesUsingWxStoryPage.map(
						(office) => ({ path: PagePath.WSPage, type: WSType.Tabs, callSign: uppercaseOffice(office) } as const)
					),
					...officeHomePageStoryMethod.wstable.map(
						(office) => ({ path: PagePath.HomePage, type: WSType.Table, callSign: uppercaseOffice(office) } as const)
					),
					...officeHomePageStoryMethod.tabs.map(
						(office) => ({ path: PagePath.HomePage, type: WSType.Tabs, callSign: uppercaseOffice(office) } as const)
					),
					...officeHomePageStoryMethod.unsure.map((office) => ({ path: null, type: null, callSign: uppercaseOffice(office) } as const)),
				] satisfies QueryValues[]
		);
		console.log({ dbQueryValues });

		await step.do('Run database updates', async () => {
			const statement = this.env.DB.prepare(`UPDATE Offices SET PageRelativePath = ?1, StoryType = ?2 WHERE CallSign = ?3;`);

			return Promise.all(
				dbQueryValues.map((v: QueryValues) =>
					step.do(`Update DB method for office ${v.callSign}`, async () => {
						await statement.bind(v.path, v.type, v.callSign).run();
					})
				)
			);
		});

		await step.do('Publish commands to Discord', async () => {
			await deploy(this.env, event.payload.guild);
		});
	}
}
export type DeployParams = {
	guild?: string;
	limit?: number;
};
export enum PagePath {
	WSPage = '/weatherstory',
	HomePage = '/',
}
export enum WSType {
	Tabs = 'tabs',
	Table = 'wstable',
}

export type QueryValues = (
	| {
			path: PagePath.WSPage;
			type: WSType.Tabs;
	  }
	| { path: PagePath.HomePage; type: WSType.Tabs | WSType.Table }
	| { path: null; type: null }
) & { callSign: Uppercase<Office> };
