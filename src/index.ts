import { Router } from '@tsndr/cloudflare-worker-router';
import { verifyKey } from 'discord-interactions';
import {
	APIChatInputApplicationCommandInteraction,
	APIInteraction,
	ApplicationCommandType,
	InteractionResponseType,
	InteractionType,
} from 'discord-api-types/payloads';
import { commands } from './interaction';
import { Env } from './env';

export * from './workflows';

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

router.any('/deploy', async ({ req, env }) => {
	const limit = 'limit' in req.query ? parseInt(req.query.limit) : undefined;
	const guild = req.query['guild'];

	await env.DEPLOY_WORKFLOW.create({
		params: {
			limit,
			guild,
		},
	});

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

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		return router.handle(req, env);
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		await env.START_WX_STORY_UPDATE_WORKFLOW.create({ params: { dev: false } });
	},
};
