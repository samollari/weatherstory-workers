import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { Env } from '../../env';
import { DeployWorkflow, PagePath, QueryValues, WSType } from '.';
import { Office, uppercaseOffice } from '../../util/offices';
import { htmlQuery } from '../../util/htmlquery';
import { NonRetryableError } from 'cloudflare:workflows';

export class UpdateOfficeMethodWorkflow extends WorkflowEntrypoint<Env, UpdateOfficeMethodParams> {
	async run(event: Readonly<WorkflowEvent<UpdateOfficeMethodParams>>, step: WorkflowStep): Promise<void> {
		try {
			const officeUsesWxStoryPage = await step.do('Determine whether office uses WX Story page', async () => {
				const response = await fetch(`https://www.weather.gov/${event.payload.office}/weatherstory`, {
					headers: {
						'User-Agent': this.env.USER_AGENT,
					},
					method: 'HEAD',
				});
				if (!response.ok && response.status != 404) {
					console.error(response.status, response.statusText, await response.text());
				}
				return response.ok;
			});

			const queryValues: QueryValues = await step.do('Determine story method', async () => {
				const office = event.payload.office;
				if (officeUsesWxStoryPage) {
					return { path: PagePath.WSPage, type: WSType.Tabs, callSign: uppercaseOffice(office) };
				}

				const homePageMethod = await step.do(`Determine home page WX Story method for office ${office}`, async () => {
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
				});

				let type: WSType | null = null;
				switch (homePageMethod) {
					case 'wstable':
						type = WSType.Table;
						break;

					case 'tabs':
						type = WSType.Tabs;
						break;
				}

				if (type === null) {
					return { path: null, type: null, callSign: uppercaseOffice(office) };
				}

				return { path: PagePath.HomePage, type, callSign: uppercaseOffice(office) };
			});

			await step.do('Run database updates', async () => {
				const statement = this.env.DB.prepare(`UPDATE Offices SET PageRelativePath = ?1, StoryType = ?2 WHERE CallSign = ?3;`);

				await statement.bind(queryValues.path, queryValues.type, queryValues.callSign).run();
			});

			await (
				await this.env.DEPLOY_WORKFLOW.get(event.payload.parentDeployWorkflowInstanceId)
			).sendEvent({
				type: DeployWorkflow.officeEventType(event.payload.office, 'success'),
				payload: null,
			});
		} catch (e) {
			await (
				await this.env.DEPLOY_WORKFLOW.get(event.payload.parentDeployWorkflowInstanceId)
			).sendEvent({
				type: DeployWorkflow.officeEventType(event.payload.office, 'failure'),
				payload: e,
			});
			if (e instanceof Error) {
				if (e instanceof NonRetryableError) {
					throw e;
				}
				throw new NonRetryableError(e.message, e.name);
			}
			throw new NonRetryableError(`Error in update office method workflow: ${e}`);
		}
	}
}

export type UpdateOfficeMethodParams = {
	office: Office;
	parentDeployWorkflowInstanceId: string;
};
