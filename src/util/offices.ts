export function officePageURL(office: string): URL {
	return new URL(`https://www.weather.gov/${office}/weatherstory`);
}
export function officeMessageKey(office: string) {
	return `${office}-message` as const;
}

// prettier-ignore
export const NWS_OFFICES = ['afg','afc','ajk','sew','pqr','otx','pdt','mso','boi','tfx','ggw','pih','sto','eka','mtr','lox','mfr','rev','hnx','sgx','lkn','vef','psr','slc','riw','byz','fgz','twc','elp','abq','ama','lub','maf','sjt','ewx','crp','bro','hgx','fwd','oun','shv','lch','tsa','lzk','lix','jan','meg','mob','bmx','hun','ohx','gum','hfo','sju','key','mfl','mlb','tbw','tae','jax','ffc','bou','gjt','pub','gld','ddc','unr','abr','bis','fgf','cys','lbf','gid','ict','top','oax','fsd','mpx','eax','sgf','arx','dmx','mqt','dlh','grb','dvn','pah','lsx','ilx','lot','mkx','apx','grr','iwx','ind','lmk','dtx','iln','rlx','pbz','jkl','chs','cae','gsp','mrx','rnk','ilm','rah','mhx','akq','lwx','cle','buf','ctp','okx','phi','bgm','aly','btv','box','gyx','car'] as const;

export type Office = (typeof NWS_OFFICES)[number];
export type CapsOffice = Uppercase<Office>;

export function uppercaseOffice<O extends Office>(office: O) {
	return office.toUpperCase() as Uppercase<O>;
}
