import { DeployParams } from './workflows/lifecycle/Deploy';
import { UnsubscribeParams } from './workflows/commands/UnsubscribeChannel';
import { SubscribeParams } from './workflows/commands/SubscribeChannel';
import { SendMessageParams } from './workflows/update-process/SendMessage';
import { OfficeParams } from './workflows/update-process/DoOfficeUpdate';
import { StartParams } from './workflows/update-process/StartUpdate';
import { UpdateOfficeMethodParams } from './workflows';

export type Env = {
	START_WX_STORY_UPDATE_WORKFLOW: Workflow<StartParams>;
	WX_STORY_PER_OFFICE_WORKFLOW: Workflow<OfficeParams>;
	SENDMESSAGE_WORKFLOW: Workflow<SendMessageParams>;
	SUBSCRIBE_WORKFLOW: Workflow<SubscribeParams>;
	UNSUBSCRIBE_WORKFLOW: Workflow<UnsubscribeParams>;
	DEPLOY_WORKFLOW: Workflow<DeployParams>;
	UPDATE_OFFICE_METHOD_WORKFLOW: Workflow<UpdateOfficeMethodParams>;

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
