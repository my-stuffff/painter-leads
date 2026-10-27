#!/usr/bin/env node
// Writes ops/probe/queries.json: 300 Google Maps search queries for the rate probe.
//
// Source: large US cities (incorporated places of roughly 100,000+ people) as listed in the US Census
// Bureau's city and town population estimates. Only a city name and its state are used: public place
// names, no people, no businesses, no client data, no database rows.
//
// Run: node scripts/probe/make-queries.mjs   (deterministic; re-running gives the same file)
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CITIES = `
New York,NY|Los Angeles,CA|Chicago,IL|Houston,TX|Phoenix,AZ|Philadelphia,PA|San Antonio,TX|San Diego,CA|Dallas,TX
Jacksonville,FL|Austin,TX|Fort Worth,TX|San Jose,CA|Columbus,OH|Charlotte,NC|Indianapolis,IN|San Francisco,CA
Seattle,WA|Denver,CO|Oklahoma City,OK|Nashville,TN|Washington,DC|El Paso,TX|Las Vegas,NV|Boston,MA|Detroit,MI
Portland,OR|Louisville,KY|Memphis,TN|Baltimore,MD|Milwaukee,WI|Albuquerque,NM|Tucson,AZ|Fresno,CA|Sacramento,CA
Mesa,AZ|Atlanta,GA|Kansas City,MO|Colorado Springs,CO|Omaha,NE|Raleigh,NC|Miami,FL|Virginia Beach,VA|Long Beach,CA
Oakland,CA|Minneapolis,MN|Bakersfield,CA|Tulsa,OK|Tampa,FL|Arlington,TX|Wichita,KS|Aurora,CO|New Orleans,LA
Cleveland,OH|Honolulu,HI|Anaheim,CA|Henderson,NV|Orlando,FL|Lexington,KY|Stockton,CA|Riverside,CA|Corpus Christi,TX
Irvine,CA|Cincinnati,OH|Santa Ana,CA|Newark,NJ|Saint Paul,MN|Pittsburgh,PA|Greensboro,NC|Durham,NC|Lincoln,NE
Jersey City,NJ|Plano,TX|Anchorage,AK|North Las Vegas,NV|St. Louis,MO|Madison,WI|Chandler,AZ|Gilbert,AZ|Reno,NV
Buffalo,NY|Chula Vista,CA|Fort Wayne,IN|Lubbock,TX|Toledo,OH|St. Petersburg,FL|Laredo,TX|Irving,TX|Chesapeake,VA
Glendale,AZ|Winston-Salem,NC|Port St. Lucie,FL|Scottsdale,AZ|Garland,TX|Boise,ID|Norfolk,VA|Spokane,WA|Richmond,VA
Fremont,CA|Huntsville,AL|Frisco,TX|Cape Coral,FL|Santa Clarita,CA|San Bernardino,CA|Tacoma,WA|Hialeah,FL
Baton Rouge,LA|Modesto,CA|Fontana,CA|McKinney,TX|Moreno Valley,CA|Des Moines,IA|Fayetteville,NC|Salt Lake City,UT
Yonkers,NY|Worcester,MA|Rochester,NY|Sioux Falls,SD|Little Rock,AR|Amarillo,TX|Tallahassee,FL|Grand Prairie,TX
Columbus,GA|Augusta,GA|Peoria,AZ|Oxnard,CA|Knoxville,TN|Overland Park,KS|Birmingham,AL|Grand Rapids,MI
Vancouver,WA|Montgomery,AL|Huntington Beach,CA|Providence,RI|Brownsville,TX|Tempe,AZ|Akron,OH|Glendale,CA
Chattanooga,TN|Fort Lauderdale,FL|Newport News,VA|Mobile,AL|Ontario,CA|Clarksville,TN|Cary,NC|Elk Grove,CA
Shreveport,LA|Eugene,OR|Aurora,IL|Salem,OR|Santa Rosa,CA|Rancho Cucamonga,CA|Pembroke Pines,FL|Fort Collins,CO
Springfield,MO|Oceanside,CA|Garden Grove,CA|Lancaster,CA|Murfreesboro,TN|Palmdale,CA|Corona,CA|Killeen,TX
Salinas,CA|Roseville,CA|Denton,TX|Surprise,AZ|Macon,GA|Paterson,NJ|Lakewood,CO|Hayward,CA|Charleston,SC
Alexandria,VA|Hollywood,FL|Springfield,MA|Kansas City,KS|Sunnyvale,CA|Bellevue,WA|Joliet,IL|Naperville,IL
Escondido,CA|Bridgeport,CT|Savannah,GA|Olathe,KS|Mesquite,TX|Pasadena,TX|McAllen,TX|Rockford,IL|Gainesville,FL
Syracuse,NY|Pomona,CA|Visalia,CA|Thornton,CO|Waco,TX|Jackson,MS|Columbia,SC|Fullerton,CA|Torrance,CA
Victorville,CA|Midland,TX|Orange,CA|Miramar,FL|Hampton,VA|Warren,MI|Stamford,CT|Cedar Rapids,IA|Elizabeth,NJ
Palm Bay,FL|Dayton,OH|New Haven,CT|Coral Springs,FL|Meridian,ID|West Valley City,UT|Pasadena,CA|Lewisville,TX
Kent,WA|Sterling Heights,MI|Fargo,ND|Carrollton,TX|Santa Clara,CA|Round Rock,TX|Norman,OK|Columbia,MO|Abilene,TX
Athens,GA|Pearland,TX|Clovis,CA|Topeka,KS|College Station,TX|Simi Valley,CA|Allentown,PA|West Palm Beach,FL
Thousand Oaks,CA|Vallejo,CA|Wilmington,NC|Rochester,MN|Concord,CA|Lakeland,FL|North Charleston,SC|Lafayette,LA
Arvada,CO|Independence,MO|Billings,MT|Fairfield,CA|Hartford,CT|Ann Arbor,MI|Broken Arrow,OK|Berkeley,CA
Cambridge,MA|Richardson,TX|Antioch,CA|High Point,NC|Clearwater,FL|League City,TX|Odessa,TX|Manchester,NH
Evansville,IN|Waterbury,CT|West Jordan,UT|Las Cruces,NM|Westminster,CO|Lowell,MA|Nampa,ID|Richmond,CA
Pompano Beach,FL|Carlsbad,CA|Menifee,CA|Provo,UT|Elgin,IL|Greeley,CO|Springfield,IL|Beaumont,TX|Lansing,MI
Murrieta,CA|Goodyear,AZ|Allen,TX|Tuscaloosa,AL|Everett,WA|Pueblo,CO|New Braunfels,TX|Miami Gardens,FL|Gresham,OR
Temecula,CA|Rio Rancho,NM|Peoria,IL|Tyler,TX|Sparks,NV|Concord,NC|Santa Maria,CA|Ventura,CA|Buckeye,AZ
Downey,CA|Sugar Land,TX|Costa Mesa,CA|Conroe,TX|Spokane Valley,WA|Davie,FL|Hillsboro,OR|Jurupa Valley,CA
Edison,NJ|Centennial,CO|Boulder,CO|Dearborn,MI|Green Bay,WI|West Covina,CA|Inglewood,CA|Norwalk,CA|Burbank,CA
El Monte,CA|Rialto,CA|Daly City,CA|Vacaville,CA|San Mateo,CA|Chico,CA|El Cajon,CA|Woodbridge,NJ|Lakewood,NJ
Boca Raton,FL|Palm Coast,FL|Deltona,FL|Lee's Summit,MO|Edmond,OK|Bend,OR|Kenosha,WI|Brockton,MA|Quincy,MA
`;

const TERMS = ['house painter', 'painting contractor'];
const COUNT = 300;

const seen = new Set();
const cities = [];
for (const chunk of CITIES.split(/[|\n]/)) {
  const entry = chunk.trim();
  if (!entry) continue;
  const [city, state] = entry.split(',');
  if (!city || !/^[A-Z]{2}$/.test(state ?? '')) throw new Error(`bad city entry: ${entry}`);
  const key = `${city},${state}`;
  if (seen.has(key)) continue;
  seen.add(key);
  cities.push({ city, state });
}
if (cities.length < COUNT) throw new Error(`need ${COUNT} cities, have ${cities.length}`);

// One query per city; the two terms alternate so neighbouring queries differ in both city and wording.
const queries = cities.slice(0, COUNT).map(({ city, state }, i) => `${TERMS[i % TERMS.length]} in ${city}, ${state}`);

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', '..', 'ops', 'probe', 'queries.json');
mkdirSync(path.dirname(out), { recursive: true });
const doc = {
  source:
    'Large US cities (about 100,000+ people) from the US Census Bureau city and town population estimates; city and state names only. Generated by scripts/probe/make-queries.mjs.',
  queries,
};
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${queries.length} queries to ${path.relative(process.cwd(), out)}`);
