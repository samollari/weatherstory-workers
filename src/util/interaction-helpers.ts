import { REST } from '@discordjs/rest';
import {
	APIApplicationCommand,
	APIApplicationCommandAutocompleteInteraction,
	APIApplicationCommandInteractionDataOption,
	APIApplicationCommandOption,
	APIApplicationCommandOptionChoice,
	APIChatInputApplicationCommandInteraction,
	ApplicationCommandOptionType,
	InteractionType,
} from 'discord-api-types/v10';
import { Env } from '../env';
import { commands } from '../interaction';

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
export function getCommandOptionValue<
	CName extends CommandName,
	OptionName extends CommandOptions<CName>[number]['name'],
	Option extends Extract<CommandOptions<CName>[number], { name: OptionName }>,
	ExpectedReturnType extends Extract<
		APIApplicationCommandInteractionDataOption<InteractionType.ApplicationCommand>,
		{ type: Option['type'] }
	>
>(
	message: APIChatInputApplicationCommandInteraction | APIApplicationCommandAutocompleteInteraction,
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

	const thisOption = commands.global[commandName].options.find((option) => option.name === optionName);
	if (!thisOption) {
		throw new Error(`Option ${optionName} not found in command ${commandName}`);
	}
	const optionRequired = 'required' in thisOption ? thisOption.required : false;

	const foundOptionValue = data.options?.find((option) => option.name === optionName);

	if (foundOptionValue === undefined && optionRequired) {
		throw new Error(`Message does not contain required option "${optionName}"`);
	}

	// @ts-expect-error doing some type nonsense above. I don't feel like making this the correct type but I know it is
	return foundOptionValue;
}

type OptionTypeSupportingChoices =
	| ApplicationCommandOptionType.String
	| ApplicationCommandOptionType.Number
	| ApplicationCommandOptionType.Integer;
type OptionTypeSupportsChoices<T extends ApplicationCommandOptionType> = T extends OptionTypeSupportingChoices ? true : false;

type OptionTypeRawType<T extends ApplicationCommandOptionType> = OptionTypeSupportsChoices<T> extends true
	? T extends ApplicationCommandOptionType.String
		? string
		: number
	: never;
type ChoiceForOptionType<T extends ApplicationCommandOptionType> = OptionTypeSupportsChoices<T> extends true
	? APIApplicationCommandOptionChoice<OptionTypeRawType<T>>
	: never;

type CallableChoices<
	T extends ApplicationCommandOptionType,
	S = OptionTypeSupportsChoices<T>,
	O = S extends true ? ChoiceForOptionType<T>[] : never
> = S extends true
	? {
			choices: (env: Env) => Promise<O> | O;
			autocomplete?: false;
	  }
	: Record<never, never>;

type OptionWithCallableChoices<
	T extends ApplicationCommandOptionType,
	O = Omit<Extract<APIApplicationCommandOption, { type: T }>, 'choices' | 'autocomplete'>
> = O & CallableChoices<T>;

type AutocompletableChoices<
	T extends ApplicationCommandOptionType,
	S = OptionTypeSupportsChoices<T>,
	V = OptionTypeRawType<T>,
	O = S extends true ? ChoiceForOptionType<T>[] : never
> = S extends true
	? {
			autocomplete: (env: Env, value: V, interaction: APIApplicationCommandAutocompleteInteraction) => Promise<O> | O;
			choices?: [];
	  }
	: Record<never, never>;
type OptionWithAutocompletableChoices<
	T extends ApplicationCommandOptionType,
	O = Omit<Extract<APIApplicationCommandOption, { type: T }>, 'choices' | 'autocomplete'>
> = O & AutocompletableChoices<T>;

export type CommandDefinition = {
	description: APIApplicationCommand['description'];
	options: (
		| OptionWithCallableChoices<ApplicationCommandOptionType.String>
		| OptionWithCallableChoices<ApplicationCommandOptionType.Number>
		| OptionWithCallableChoices<ApplicationCommandOptionType.Integer>
		| OptionWithAutocompletableChoices<ApplicationCommandOptionType.String>
		| OptionWithAutocompletableChoices<ApplicationCommandOptionType.Number>
		| OptionWithAutocompletableChoices<ApplicationCommandOptionType.Integer>
	)[];
	run(env: Env, message: APIChatInputApplicationCommandInteraction): Promise<Response> | Response;
};

export type CommandDefinitions = {
	global: {
		[key: string]: CommandDefinition;
	};
};
