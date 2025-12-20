import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NWS_OFFICES, Office } from '../../util/offices';
import { Env } from '../../env';
import { deploy } from '../../interaction';
import { chunk, limit } from '../../util/array';

export class DeployWorkflow extends WorkflowEntrypoint<Env, DeployParams> {
	async run(event: Readonly<WorkflowEvent<DeployParams>>, step: WorkflowStep): Promise<void> {
		const offices = await step.do('Collect offices for this run', async () => limit(NWS_OFFICES, event.payload.limit));

		await step.do('Run office method updates in batches and wait for them all to succeed', async () => {
			for (const officesChunk of chunk(offices, 100)) {
				await this.env.UPDATE_OFFICE_METHOD_WORKFLOW.createBatch(
					officesChunk.map((office) => ({ params: { office, parentDeployWorkflowInstanceId: event.instanceId } }))
				);
			}
			await Promise.all(
				offices.map(
					(office) =>
						new Promise((resolve, reject) => {
							step
								.waitForEvent(`Wait for ${office} success`, {
									type: DeployWorkflow.officeEventType(office, 'success'),
									timeout: '15 minutes',
								})
								.then(() => resolve);
							step
								.waitForEvent(`Wait for ${office} failure`, {
									type: DeployWorkflow.officeEventType(office, 'failure'),
									timeout: '15 minutes',
								})
								.then(() => reject);
						})
				)
			);
		});

		await step.do('Publish commands to Discord', async () => {
			await deploy(this.env, event.payload.guild);
		});
	}

	static officeEventType<O extends Office, T extends 'success' | 'failure'>(office: O, eventType: T): `${O}-update-${T}` {
		return `${office}-update-${eventType}`;
	}
}
export type DeployParams = {
	guild?: string;
	limit?: number;
	chunkSize?: number;
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
