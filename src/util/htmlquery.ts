import un from '@nrsk/unindent';

export type HTMLQuery = {
	/** CSS Selector to query for */
	query: string;
	/** Optional attribute to read values of, instead of innerText */
	attribute?: string;
};

/**
 * Query HTML content
 * @param html Some HTML content (may be streamed)
 * @param queries Queries to execute (CSS selector and optional attribute)
 * @returns
 */
export async function htmlQuery<Queries extends Record<string, HTMLQuery>>(html: BodyInit, queries: Queries) {
	const queryResponses: { [key: string]: string[] } = {};

	let rewriter = new HTMLRewriter();
	for (const entry of Object.entries(queries)) {
		const [key, query] = entry;
		const queryAttribute = query.attribute;
		const thisQueryResponses: (typeof queryResponses)[keyof typeof queryResponses] = (queryResponses[key] = []);

		if (queryAttribute) {
			rewriter = rewriter.on(query.query, {
				element(element) {
					const attributeValue = element.getAttribute(queryAttribute);
					if (!attributeValue) {
						return;
					}
					thisQueryResponses.push(attributeValue);
				},
			});
		} else {
			rewriter = rewriter.on(query.query, {
				element() {
					thisQueryResponses.push('');
				},
				text(element) {
					const lastIndex = thisQueryResponses.length - 1;
					thisQueryResponses[lastIndex] += element.text;
					if (element.lastInTextNode) {
						thisQueryResponses[lastIndex] = un(thisQueryResponses[lastIndex]);
						const matches = /(.*\S)\s*/s.exec(thisQueryResponses[lastIndex]);
						if (matches) {
							thisQueryResponses[lastIndex] = matches[1];
						}
					}
				},
			});
		}
	}

	const tempResponseToTransform = new Response(html);

	const transformedResponse = rewriter.transform(tempResponseToTransform);

	await transformedResponse.text();

	return queryResponses as Record<keyof Queries, string[]>;
}
