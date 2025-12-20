import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { Env } from '../../env';

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

// User-defined params passed to your workflow

export type StartParams = {
	dev: boolean;
};
// </docs-tag name="workflow-entrypoint">
