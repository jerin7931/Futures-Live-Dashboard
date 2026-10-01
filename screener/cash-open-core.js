export const PAGES=new Set(["home","options-analysis","spx-fast"]);

export function route(hash=""){
  const parts=String(hash).replace(/^#\/?/,"").split("/").filter(Boolean);
  const demo=parts[0]==="demo",requested=demo?parts[1]:parts[0];
  return {demo,page:PAGES.has(requested)?requested:"home",redirect:Boolean(requested&&!PAGES.has(requested))};
}

export const href=(page,demo=false)=>`#/${demo?"demo/":""}${PAGES.has(page)?page:"home"}`;

export function newYorkDate(date=new Date()){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const get=type=>parts.find(part=>part.type===type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function chicagoDate(date=new Date()){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const get=type=>parts.find(part=>part.type===type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
