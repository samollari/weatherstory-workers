import {
	APIApplicationCommandOption,
	APIInteractionResponseDeferredChannelMessageWithSource,
	ApplicationCommandOptionType,
	ApplicationCommandType,
	InteractionResponseType,
	RESTGetAPIApplicationCommandsResult,
	RESTPutAPIApplicationCommandsJSONBody,
	RESTPutAPIApplicationGuildCommandsJSONBody,
	Routes,
	Snowflake,
} from 'discord-api-types/v10';
import type { Env } from './env';
import { DiscordAPIError } from '@discordjs/rest';
import { CommandDefinitions, getCommandOptionValue, RESTAPI } from './util/interaction-helpers';
import { CapsOffice } from './util/offices';

async function autocompleteOffices(env: Env, value: string) {
	console.log(`Autocomplete "${value}"`);
	const statement = env.DB.prepare(`
		SELECT 
			CallSign, 
			OfficeName, 
			MIN(Priority) AS TopPriority
		FROM (
			-- Priority 1: Call sign starts with search term
			SELECT CallSign, OfficeName, 1 AS Priority
			FROM Offices
			WHERE
				CallSign LIKE ?1
				AND Supported = 1
			
			UNION ALL

			-- Priority 2: Office name starts with search term
			SELECT CallSign, OfficeName, 2 as Priority
			FROM Offices
			WHERE
				OfficeName LIKE ?1
				AND Supported = 1

			UNION ALL
			
			-- Priority 3: search term is in call sign OR in the OfficeName
			SELECT CallSign, OfficeName, 3 AS Priority
			FROM Offices
			WHERE
				CallSign LIKE ?2
				OR OfficeName LIKE ?2
				AND Supported = 1
		)
		GROUP BY CallSign
		ORDER BY TopPriority ASC
		LIMIT 25;
	`);

	const { results } = await statement
		.bind(`${value}%`, `%${value}%`)
		.run<{ CallSign: CapsOffice; OfficeName: string; TopPriority: number }>();

	return results.map((result) => ({
		name: `${result.CallSign} - ${result.OfficeName}`,
		value: `${result.CallSign.toLowerCase()}`,
	}));
}

export const commands = {
	global: {
		subscribe: {
			description: 'Subscribe this channel to updates from a specific office',
			options: [
				{
					type: ApplicationCommandOptionType.String,
					required: true,
					name: 'office',
					description: 'Office to get updates from',
					autocomplete: (env: Env, value: string) => autocompleteOffices(env, value),
					min_length: 3,
					max_length: 3,
				},
			],
			async run(env, message) {
				const { guild_id: guild, token } = message;
				const channel = message.channel.id;
				const { value: office } = getCommandOptionValue(message, 'subscribe', 'office');

				const workflowInstance = await env.SUBSCRIBE_WORKFLOW.create({
					params: {
						office,
						guild,
						channel,
						token,
					},
				});

				return Response.json({
					type: InteractionResponseType.DeferredChannelMessageWithSource,
				} satisfies APIInteractionResponseDeferredChannelMessageWithSource);
			},
		},
		unsubscribe: {
			description: 'Unsubscribe this channel from updates from a specific office or from all offices',
			options: [
				{
					type: ApplicationCommandOptionType.String,
					name: 'office',
					description: 'Office to unsubscribe from',
					autocomplete: (env, value) => autocompleteOffices(env, value), // TODO: Autocomplete based on current subscriptions
					min_length: 3,
					max_length: 3,
				},
			],
			async run(env, message) {
				const { token } = message;
				const channel = message.channel.id;
				const office = getCommandOptionValue(message, 'unsubscribe', 'office')?.value;

				const workflowInstance = await env.UNSUBSCRIBE_WORKFLOW.create({
					params: {
						office,
						channel,
						token,
					},
				});

				return Response.json({
					type: InteractionResponseType.DeferredChannelMessageWithSource,
				} satisfies APIInteractionResponseDeferredChannelMessageWithSource);
			},
		},
		// 'getstory': {}
	},
} as const satisfies CommandDefinitions;

export async function deploy(env: Env, guild?: Snowflake) {
	const { DISCORD_APP_ID, DISCORD_BOT_TOKEN } = env;
	const route = guild ? Routes.applicationGuildCommands(DISCORD_APP_ID, guild) : Routes.applicationCommands(DISCORD_APP_ID);

	const rest = RESTAPI.getInstance(DISCORD_BOT_TOKEN);

	const response = (await rest.get(route)) as RESTGetAPIApplicationCommandsResult;
	console.log('Existing commands:', response);
	const existingCommandIdMap = Object.fromEntries(response.map(({ name, id }) => [name, id]));

	const currentCommandNames = Object.keys(commands.global) as (keyof typeof commands.global)[];

	const builtCommandList = (await Promise.all(
		currentCommandNames.map(async (name) => {
			const { description, options } = (commands as CommandDefinitions).global[name];
			const definition = {
				id: existingCommandIdMap[name],
				type: ApplicationCommandType.ChatInput as const,
				name,
				description,
				options: (await Promise.all(
					options.map(async (option) => {
						if ('choices' in option && typeof option.choices === 'function') {
							let { choices, ...restParams } = option;
							return { ...restParams, choices: await choices(env) } as APIApplicationCommandOption;
						}
						if ('autocomplete' in option) {
							let { autocomplete, ...restParams } = option;
							return { ...restParams, autocomplete: true } as APIApplicationCommandOption;
						}
						throw new Error('uh oh! transforming options');
					})
				)) as APIApplicationCommandOption[], // FIXME: I would love this to be a "satisfies" or not exist at all. Unfortunately, my type hacking is hacky
			};
			return definition;
		})
	)) satisfies RESTPutAPIApplicationCommandsJSONBody & RESTPutAPIApplicationGuildCommandsJSONBody;

	console.log('Built command list:', builtCommandList);

	try {
		const responseCommands = (await rest.put(route, {
			body: builtCommandList,
		})) as RESTPutAPIApplicationGuildCommandsJSONBody;
		console.log({ responseCommands });
	} catch (e) {
		if (e instanceof DiscordAPIError) {
			console.log(JSON.stringify(e.rawError));
		}
		throw e;
	}
}
