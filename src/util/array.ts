export function limit<T>(array: T[] | readonly T[], limit: number | undefined) {
	return limit !== undefined ? array.slice(0, limit) : array;
}

export function chunk<T>(array: T[] | readonly T[], chunkSize: number) {
	const chunks: T[][] = [];
	for (let startIdx = 0; startIdx < array.length; startIdx += chunkSize) {
		chunks.push(array.slice(startIdx, startIdx + chunkSize));
	}
	return chunks;
}

export async function chunkedAsyncMap<T, R>(
	array: T[] | readonly T[],
	chunkSize: number,
	mapper: (val: T, index: number, arr: T[]) => Promise<R>
): Promise<R[]> {
	const chunks = chunk(array, chunkSize);

	const chunkedResults: R[] = [];

	for (const chunk of chunks) {
		chunkedResults.push(...(await Promise.all(chunk.map((v, i, a) => mapper(v, i, a)))));
	}

	return chunkedResults;
}
