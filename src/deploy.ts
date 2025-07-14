import { config } from 'dotenv';
import parseArgs from 'command-line-args';
import { deploy } from './interaction';

(async () => {
	const args = parseArgs([
		{
			name: 'guild',
			defaultOption: true,
		},
	]);

	config({ path: '.dev.vars', quiet: true });
	const { DISCORD_APP_ID, DISCORD_BOT_TOKEN } = process.env;

	if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN) {
		console.error('Expected environment variables not defined');
		process.exit(1);
	}

	await deploy({ DISCORD_APP_ID, DISCORD_BOT_TOKEN }, args.guild);
})();
