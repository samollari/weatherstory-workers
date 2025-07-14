import {
	APIApplicationCommand,
	APIApplicationCommandInteractionDataOption,
	APIChatInputApplicationCommandInteraction,
	APIInteractionResponseDeferredChannelMessageWithSource,
	ApplicationCommandOptionType,
	ApplicationCommandType,
	InteractionResponseType,
	InteractionType,
	RESTGetAPIApplicationCommandsResult,
	RESTPutAPIApplicationCommandsJSONBody,
	RESTPutAPIApplicationGuildCommandsJSONBody,
	Routes,
	Snowflake,
} from 'discord-api-types/v10';
import type { Env } from '.';
import { REST } from '@discordjs/rest';

export class RESTAPI {
	private static state: { token: string; rest: REST } | undefined = undefined;
	public static getInstance(token: string) {
		if (!this.state) {
			this.state = {
				token: token,
				rest: new REST().setToken(token),
			};
		}

		if (token === this.state.token) {
			return this.state.rest;
		} else {
			throw new Error('Token does not match memoized value!');
		}
	}
}

const supportedSelfServiceOffices = [
	// TODO: Dynamically generate these choices from the database of supported offices when invoked
	{
		name: 'BOX - Boston/Norton, MA',
		value: 'BOX',
	},
];

type CommandName = keyof typeof commands.global;

type CommandOptions<CName extends CommandName> = (typeof commands.global)[CName]['options'];

/*
 * I'm sorry for this atrocity of generics, but they're all doing important things.
 * CName gets all known command names from the definition below for IntelliSense. Once the dev selects a command as a parameter, CName becomes that command's name.
 * OptionName then collects all known option names for that command for IntelliSense. Again, becomes the selected option name once dev selects.
 * OptionIndex is a helper.
 * Option then picks the correct option definition based on the command and option names defined by the dev.
 * ExpectedReturnType then picks the correct option subtype based on the defined option type.
 * The return type types the implementation behavior, where non-required options may not be included and may return undefined, while required options will always return a value (or throw an exception and not return)
 */
// TODO: Possible to get commandName automatically somehow? Like defining commands with classes and having this be on a parent class, with command name being a generic?
function getCommandOptionValue<
	CName extends CommandName,
	OptionName extends CommandOptions<CName>[number]['name'],
	OptionIndex extends number,
	Option extends CommandOptions<CName>[OptionIndex]['name'] extends OptionName ? CommandOptions<CName>[OptionIndex] : never,
	ExpectedReturnType extends APIApplicationCommandInteractionDataOption<InteractionType.ApplicationCommand> & { type: Option['type'] }
>(
	message: APIChatInputApplicationCommandInteraction,
	commandName: CName,
	optionName: OptionName
): Option extends { required: boolean }
	? Option['required'] extends true
		? ExpectedReturnType
		: ExpectedReturnType | undefined
	: ExpectedReturnType | undefined {
	const { data } = message;
	if (data.name !== commandName) {
		throw new Error(`Message does not match expected command (got "${data.name}", expected "${commandName}")`);
	}

	const thisOption = commands.global[commandName].options.find((option) => option.name === optionName)!;
	const optionRequired = 'required' in thisOption ? thisOption.required : false;

	const foundOptionValue = data.options?.find((option) => option.name === optionName);

	if (foundOptionValue === undefined && optionRequired) {
		throw new Error(`Message does not contain required option "${optionName}"`);
	}

	// @ts-expect-error doing some type nonsense above. I don't feel like making this the correct type but I know it is
	return foundOptionValue;
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
					choices: supportedSelfServiceOffices,
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
					choices: supportedSelfServiceOffices, // TODO: Autocomplete based on current subscriptions
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
} as const satisfies {
	global: {
		[key: string]: Pick<APIApplicationCommand, 'description' | 'options'> & {
			run(env: Env, message: APIChatInputApplicationCommandInteraction): Promise<Response> | Response;
		};
	};
};

export async function deploy({ DISCORD_APP_ID, DISCORD_BOT_TOKEN }: Pick<Env, 'DISCORD_APP_ID' | 'DISCORD_BOT_TOKEN'>, guild?: Snowflake) {
	const route = guild ? Routes.applicationGuildCommands(DISCORD_APP_ID, guild) : Routes.applicationCommands(DISCORD_APP_ID);

	const rest = RESTAPI.getInstance(DISCORD_BOT_TOKEN);

	const response = (await rest.get(route)) as RESTGetAPIApplicationCommandsResult;
	console.log('Existing commands:', response);
	const existingCommandIdMap = Object.fromEntries(response.map(({ name, id }) => [name, id]));

	const currentCommandNames = Object.keys(commands.global) as (keyof typeof commands.global)[];

	const builtCommandList = currentCommandNames.map((name) => {
		const { description, options } = commands.global[name];
		const definition = {
			id: existingCommandIdMap[name],
			type: ApplicationCommandType.ChatInput as const,
			name,
			description,
			options,
		};
		return definition;
	}) satisfies RESTPutAPIApplicationCommandsJSONBody & RESTPutAPIApplicationGuildCommandsJSONBody;

	console.log('Built command list:', builtCommandList);

	const responseCommands = (await rest.put(route, {
		body: builtCommandList,
	})) as RESTPutAPIApplicationGuildCommandsJSONBody;
	console.log({ responseCommands });
}
