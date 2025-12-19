import { parse } from 'node-html-parser';
import { readFile } from 'node:fs/promises';

const LIMIT = Infinity;

const FETCH_OPTIONS = {
	headers: {
		'User-Agent': 'Weather Story URL Finder - sam@gizm0.dev',
	},
} satisfies RequestInit;

(async () => {
	const offices = (await readFile('./offices.tsv', { encoding: 'utf8' })).split('\n').map((line) => line.split('\t')[0]);
	console.log(`[${offices.map((s) => `'${s}'`).toString()}]`);
	// const offices = ['otx', 'tfx', 'ggw', 'lox', 'rev', 'hnx', 'sgx', 'lkn', 'vef', 'psr', 'byz', 'fgz', 'twc'];

	const onWeatherStoryPage: string[] = [],
		onOfficeHomePage: { code: string; method: string }[] = [],
		unsure: string[] = [];

	let i = 0;
	for (const code of offices) {
		if (i >= LIMIT) {
			console.warn(`Limited to ${LIMIT}`);
			break;
		}
		i++;

		const wxStoryResponse = await fetch(`https://www.weather.gov/${code}/weatherstory`, { ...FETCH_OPTIONS, method: 'HEAD' });
		if (wxStoryResponse.ok) {
			onWeatherStoryPage.push(code);
			continue;
		}

		if (wxStoryResponse.status != 404) {
			console.error(wxStoryResponse.status, wxStoryResponse.statusText, await wxStoryResponse.text());
			break;
		}

		const officeHomeResponse = await fetch(`https://www.weather.gov/${code}`, FETCH_OPTIONS);
		if (!officeHomeResponse.ok) {
			unsure.push(code);

			console.error(officeHomeResponse.status, officeHomeResponse.statusText, await officeHomeResponse.text());
			break;
		}

		const officeHomeHTML = await officeHomeResponse.text();
		const pageRoot = parse(officeHomeHTML);

		if (pageRoot.querySelector('#WStable')) {
			onOfficeHomePage.push({ code, method: 'wstable' });
			continue;
		}

		if (pageRoot.querySelector('#tabs .graphicast')) {
			onOfficeHomePage.push({ code, method: 'graphicast tabs' });
			continue;
		}

		if (pageRoot.querySelectorAll('img').some((el) => el.getAttribute('src')?.toLowerCase().includes('weatherstory'))) {
			onOfficeHomePage.push({ code, method: 'image' });
			continue;
		}

		unsure.push(code);
	}

	if (i != offices.length) {
		console.warn(`Exited after ${i} checks`);
	}

	console.log(`${onWeatherStoryPage.length} on /weatherstory:`, onWeatherStoryPage);
	console.log(`${onOfficeHomePage.length} on home page:`, onOfficeHomePage);
	console.log(`${unsure.length} unsure:`, unsure);
})();
