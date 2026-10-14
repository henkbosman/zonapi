# ZonAPI — lokaal zonnestroomadvies

Node.js-dienst voor een Growatt ShineLanBox, lokale HomeWizard-meters, Open-Meteo-instraling, een SQLite-historie, ESP32-endpoints en een dashboard. **Er is geen verbinding met Growatt geprogrammeerd.** De Growatt TCP-listener ontvangt de ShineLanBox-pakketten en stuurt uitsluitend lokale protocolbevestigingen en een configureerbare tijdsynchronisatie terug. De enige externe dienst is de gekozen weerservice.

## Wat is al werkend en wat vereist controle?

- Alle softwareonderdelen, database, scheduler, HomeWizard v1/v2, API, dashboard en machineberekening zijn aanwezig. Integratietests gebruiken synthetische weer- en Growatt-pakketten.
- De Growatt-decoder gebruikt de generieke offsets uit [Grott](https://github.com/johanmeijer/grott/blob/master/grottconf.py). De ACK-volgorde, tijdopdracht en de interpretatie van de automatische `xx03`/`xx04`-rapporten zijn ook vergeleken met de onafhankelijke [growatt-protocol](https://github.com/FezVrasta/growatt-datalogger/blob/main/packages/growatt-protocol/README.md)- en [shine2mqtt](https://github.com/bremme/shine2mqtt/blob/main/docs/protocol.md)-implementaties. Bij de aangesloten ShineLanBox 7.0.0.4 zijn volgens de live-observatie `xx04`-berichten voor drie van de vier MIC 2000TL-X-omvormers ontvangen. Onbekende layouts worden in de eigen SQLite-database bewaard en als `unknown_layout` getoond. Controleer in `/growatt` het serienummer en vermogen per omvormer en vergelijk met de eigen metingen.
- Open-Meteo en je HomeWizard-apparaten waren tijdens ontwikkeling niet vanuit dit project bereikbaar; voor live data zijn jouw locatie, paneelwaarden en lokale meteradressen nog nodig.

## Snel starten op Arch Linux

1. Installeer Node.js **24 of nieuwer** (`node --version`). Er zijn geen npm-pakketten of cloudopslag nodig; SQLite gebruikt `node:sqlite`.
2. Kopieer deze hele map naar de server. Pas **`config/settings.json`**, **`config/panels.json`** en desgewenst de drie bestanden in **`config/appliances/`** aan. De voorbeeldpanelen bevatten bewust geen verzonnen Wp, hellingshoek of verdeling over omvormers.
3. Start in de projectmap met `npm start` of `node src/main.js`. Open eerst `http://127.0.0.1:8080/dashboard`. De database en dagelijkse back-ups verschijnen in `data/`.
4. Stel `http.host` en `growatt.host` in op het **LAN-IP van deze Arch Linux-server**, bijvoorbeeld `192.168.1.20`, en herstart. Laat uitsluitend lokale apparaten bij de twee poorten. Plaats de API niet achter een publiek bereikbare website/proxy.
5. Stel in de ShineLanBox-serverinstellingen **ditzelfde lokale IP en poort 5279** in. Een DNS-omleiding is niet nodig. Zorg via je lokale firewall/router ook dat ShineLanBox en de Node.js-dienst niet naar Growatt kunnen verbinden. Controleer `GET /api/v1/status` op ontvangen/gedecodeerde Growatt-pakketten en vier omvormers.
6. Vul voor P1 en kWh-meter de **eigen LAN-IP-adressen** in bij `homewizard.p1.host` en `homewizard.kwh.host`. De API leest beide onafhankelijk maar telt ze nooit bij elkaar op: het is volgens jouw informatie hetzelfde eenfasige netmeetpunt. De standaardvolgorde voor een verse actuele netmeting is P1, daarna kWh; verander `net_meter_priority` als gewenst.

Herstart na wijzigingen van `settings.json`, `panels.json` en `layouts/*.json`. Apparatenprofielen uit `config/appliances/*.json` worden opnieuw ingelezen bij elke API-aanvraag. Het dashboard maakt zichzelf elke 30 seconden opnieuw actueel.

### Bestaande installatie bijwerken

Stop de Node-dienst en bewaar een kopie van `data/zonapi.sqlite`. Kopieer voor deze versie de mappen `src/` en `public/` uit het archief naar de bestaande installatie en start de dienst opnieuw. Behoud de eigen `config/settings.json`, `config/panels.json`, `config/appliances/` en de hele `data/`-map. De bestaande database wordt bij de eerste start gemigreerd; de opgeslagen opbrengst blijft behouden. Als `growatt.time_sync_on_announcement` ontbreekt, staat de lokale tijdsynchronisatie standaard aan; zonder `growatt.time_sync_retry_minutes` is het herhaalinterval 10 minuten. Na een nieuwe `xx03`-aanmelding staan `reply_sent` en `time_sync_sent` in `/growatt`. De dienst verstuurt opnieuw een tijdopdracht als de vier `xx04`-adressen op die verbinding uitblijven.

### Instellingen

| Bestand/veld | Vul in / werking |
| --- | --- |
| `settings.json > location` | Breedte- en lengtegraad van je locatie. Er wordt vóór dit is ingevuld geen extern weerverzoek gedaan. |
| `settings.json > http` | LAN-IP en HTTP-poort voor ESP32's/dashboard. Begint uit voorzorg op `127.0.0.1`. |
| `settings.json > growatt` | LAN-IP/poort voor ShineLanBox; standaard 5279, verwacht vier omvormers. `idle_timeout_minutes` is standaard 30 (instelbaar 1–120). `time_sync_on_announcement` is standaard `true`, ook in bestaande configuraties zonder dit veld. `time_sync_retry_minutes` is standaard 10 (instelbaar 1–120). |
| `settings.json > weather.max_requests_per_local_day` | Standaard 12, instelbaar 0–48; `0` pauzeert de externe bron. Een mislukte poging telt mee; teller overleeft herstart. Alleen tussen zonsopkomst en zonsondergang, met minimaal ongeveer één uur tussen normale pogingen. |
| `settings.json > weather.forecast_days` | Standaard 3; verleng als het adviesvenster veel langer dan 24 uur wordt. Kwartierstarttijden worden tegen de **uurvoorspelling** getoetst; dit is geen echte kwartierprognose. |
| `settings.json > advice.search_hours` | Standaard 24; advies controleert ook de **volledige** cyclus voorbij dat laatste starttijdstip. |
| `settings.json > advice.min_solar_share` | Standaard `0.7` (70% van de voorspelde apparaatenergie uit eigen opwek). Apparaten mogen een eigen `min_solar_share` hebben; netafname blijft mogelijk. |
| `settings.json > advice.reserve_w` | Vermogensmarge bovenop de geschatte huisbasislast, standaard 300 W. |
| `settings.json > advice.baseload_w` | `null` leert een voorzichtige basislast uit minstens 12 uitgelijnde netto- en vier omvormermetingen; of stel zelf een bekende constante in. De P1 is primair, de kWh-meter kan als alternatieve historie dienen. |
| `panels.json > groups` | Eerst 20 panelen op het zuiden (`azimuth_deg: 180`), maar **Wp, helling en omvormertoewijzing moeten worden ingevuld**. Splits een groep in meerdere richtingen door meerdere regels te maken; de aantallen tellen op tot 20. |
| `appliances/*.json` | Elk apparaat heeft `steps` met `duration_minutes` en `power_w`, en optioneel eigen `reserve_w` en `min_solar_share`. De meegeleverde 90/150/210 minuten en wattages zijn **schattingen**, te vervangen door eigen metingen. |

Een enkele groep van 20 panelen heeft geen echte `inverter_id` totdat je weet hoe de panelen verdeeld zijn. Maak vervolgens bijvoorbeeld groepen per omvormer met id `mic-1` … `mic-4`, en zet per groep het juiste aantal, `wp_per_panel` en `tilt_deg` in `panels.json`. Er worden geen extra weerserviceverzoeken gedaan als je later een deel naar oost of west verlegt: één GHI/DNI/DHI-reeks wordt lokaal omgerekend naar ieder paneelvlak. Vul de vier echte omvormerserienummers in `inverters[].serial` in wanneer ze bekend zijn; daarna worden onbekende serienummers niet in de actuele totaalsom opgenomen.

### HomeWizard lokaal

Gebruik eerst `api: "v1"` als jouw firmware de [HomeWizard lokale API v1](https://api-documentation.homewizard.com/docs/v1/measurement/) aanbiedt. Als jouw apparaat v2 vereist, zet dat apparaat op `api: "v2"`, maak op het **apparaat zelf** een lokaal token via [de fysieke knop en `POST /api/user`](https://api-documentation.homewizard.com/docs/v2/authorization/), en geef het token aan de systemd-dienst via `/etc/zonapi/homewizard.env`:

```ini
HOMEWIZARD_P1_TOKEN=token-van-p1
HOMEWIZARD_KWH_TOKEN=token-van-kwh-meter
```

Beperk leesrechten op dit bestand tot de servicegebruiker. Voor v2 HTTPS stel je `ca_file` in met de [officiële HomeWizard-CA](https://api-documentation.homewizard.com/docs/v2/authorization/) en `tls_servername` met de certificaatidentiteit `appliance/p1dongle/<serienummer>` of `appliance/energymeter/<serienummer>`. De code controleert die naam in het certificaat, zonder hem als ongeldige SNI-hostnaam te verzenden. Als je op je eigen LAN de certificaatcontrole bewust wilt overslaan, kan per apparaat `tls_insecure_skip_verify` op `true` worden gezet; dit geldt **alleen** voor de directe verbinding met dat apparaat. Er wordt geen HomeWizard-cloud-API gebruikt. Bij uitval van P1 wordt de kWh-meter als vervangende netmeting gebruikt; bij beide apparaten zie je apart hun historie.

### Arch Linux met systemd

`systemd/zonapi.service` is een voorbeeld voor installatie onder `/opt/zonapi` met een eigen gebruiker `zonapi` en schrijfbare `/opt/zonapi/data`. Kopieer het servicebestand naar `/etc/systemd/system/zonapi.service`, maak de gebruiker/datamap met passende eigendom en leesrechten aan, en start met `sudo systemctl daemon-reload` en `sudo systemctl enable --now zonapi`. De dienst krijgt alleen de datamap als schrijfbare locatie. De SQLite-back-up `data/backups/zonapi-YYYY-MM-DD.sqlite` wordt bij het starten en ongeveer elke zes uur atomair bijgewerkt; bewaar af en toe ook een kopie buiten deze server. Alle tijden in DB/API zijn UTC, het dashboard toont `Europe/Amsterdam`.

## Endpoints

| Pad | Resultaat |
| --- | --- |
| `GET /api/v1/forecast?hours=3` | GHI/DNI/DHI en eigen PV-berekening voor komende uren; `power_w:null` met ontbrekende configuratie als panelen nog niet ingesteld zijn. |
| `GET /api/v1/irradiance?hours=3` | Instraling per uur en berekende GTI per paneelgroep. |
| `GET /api/v1/production/current` | Afzonderlijke omvormers plus uitsluitend bij vier verse metingen een betrouwbare som. |
| `GET /api/v1/production/day` | Beschikbare omvormermetingen van vandaag, samengevoegd op meettijd, met het aantal actieve omvormers per punt en zonsopgang/-ondergang. |
| `GET /api/v1/growatt?limit=50` | Growatt-listener, ontvangen pakkettypen/statussen, omvormers en recente fouten; maximaal 100 pakketten per aanvraag. |
| `GET /api/v1/growatt/timeline?type=xx04&limit=100` | Gecombineerde chronologische lijst van ontvangen pakketten en TCP-gebeurtenissen, met filters `type` (`xx04` of `5004`), `address` (`50`–`53`), `view` (`all`, `packets`, `errors`, `events`) en paginering via `offset`. `has_more` geeft aan of er meer regels zijn. |
| `GET /api/v1/growatt/frames/:id` | Eén ontvangen pakket inclusief de oorspronkelijke hex-inhoud en eventuele gedecodeerde meting. |
| `DELETE /api/v1/growatt/diagnostics` | Verwijdert Growatt-pakketten en verbindings-/antwoordlogs, behoudt opgeslagen opbrengstmetingen; geeft verwijderde aantallen terug. De Growatt-pagina biedt hiervoor een knop met bevestiging. |
| `GET /api/v1/meters/current` | P1 en kWh afzonderlijk, plus precies **één** gekozen netto netvermogen. Positief = import, negatief = export. |
| `GET /api/v1/history?metric=irradiance&from=...&to=...` | Bestaande time series. `metric`: `irradiance`, `pv_forecast`, `inverter`, `p1` of `kwh`; `limit` max. 5000. Bij voorspellingen overschrijft een nieuwere bronwaarde hetzelfde tijdvak. |
| `GET /api/v1/appliances` | Geldige JSON-profielen en eventuele laad-/validatiefouten. |
| `GET /api/v1/appliances/wasmachine/advice` | `can_start_now`, `earliest_start`, `best_start`, volledige zonnefractie en status (`ok`, `stale`, `forecast_incomplete`, enzovoort). Ook `droger` en `vaatwasser`. |
| `GET /api/v1/status` | Bronnen, configuratiefouten, historisch aantal ontvangen frames, zontijden, gebruikt/dagmaximum en volgende weersophaling. |
| `GET /dashboard` | Gemeten opbrengst en drie uur voorspelling op één as tussen zonsopgang en zonsondergang met lijn voor de huidige tijd; toont ook de beschikbare metingen bij minder dan vier omvormers. |
| `GET /growatt` | Growatt-pagina met omvormermetingen, tijdlijn voor pakketten, antwoorden, tijdsynchronisatie en verbindingen, filters, verwijderknop en verversing iedere 15 seconden. |

Bijvoorbeeld voor een ESP32: lees `can_start_now` alleen als `status === "ok"`; bij `null`, `stale` of ontbrekende instellingen toon je "onbekend" in plaats van "nee". `earliest_start` kan na drie uur liggen. `best_start` laat de beste optie zien als de drempel nergens wordt gehaald.

## Growatt-validatie bij eerste live-verbinding

1. Laat de dienst eerst lokaal draaien, verplaats daarna het ingestelde ShineLanBox-serveradres. De decoder ontvangt op de ingestelde TCP-poort; de software heeft geen uitgaand Growatt-adres en gebruikt geen proxy.
2. Bekijk `/api/v1/status`: `frames` toont `decoded:...`, `unknown_layout`, `bad_crc` en dergelijke; de individuele omvormers staan er met meettijd. In `config/layouts/README.md` staat het schema voor alternatieve layouts.
   Via `/growatt` zijn de berichttypen, ontvangen bytes en TCP-gebeurtenissen direct in de browser te bekijken. Kies `xx04` om ook eerdere meetpakketten te vinden die niet bij de laatste honderd berichten staan. De knop Vernieuwen en het tijdstip Bijgewerkt tonen of nieuwe gegevens zijn opgehaald. De hex-inhoud kan serienummers bevatten.
   ShineLanBox-v06-aanmeldingen met type `5003`–`5303` of `5029`–`5329` tonen de adressen `50`–`53`, omvormerserienummers en logger. Open een `xx29`-pakket met **Bekijk** om per RF-stick het update-interval, de firmware, tijdzone en apparaatklok te lezen. In de vier verstrekte voorbeelden meldt adres `50` 5 minuten en melden adressen `51`–`53` elk 1 minuut. Deze pakketten bevatten geen actuele vermogensmeting; daarvoor is een datarecord nodig (`xx04` of `xx50`).
3. Vergelijk meerdere werkelijk gemeten wattages en energietellers **per serienummer** met de eigen omvormers. Controleer herverbinding en of oudere gebufferde pakketten niet het actuele vermogen vervangen. Gebruik desgewenst lokaal `node scripts/inspect-frames.js` voor pakketstatus; `--hex` toont privégegevens, waaronder serienummers.
4. Verifieer met router/firewall/netwerktrace dat noch de ShineLanBox noch deze dienst verbinding maakt met Growatt. Of jouw ShineLanBox 7.0.0.4 de generieke ACK van de lokale TCP-server accepteert, kan pas met de echte hardware worden bevestigd. Als dat niet zo is, zijn de bewaarde pakketten de input voor een gerichte protocolaanpassing.

Een ontvangen `5004` verschijnt als omvormermeting onder het serienummer van adres `50`. De totale actuele opbrengst in de API wordt pas gevuld wanneer alle vier omvormers een recente `xx04`-meting hebben; de grafiek tekent ook beschikbare deelmetingen en vermeldt hoeveel omvormers meetelden. Bekijk na elk bericht `reply_sent` in `/growatt` voor de lokaal geschreven antwoordbytes. ZonAPI schrijft de ACK vóór het decoderen; direct daarna volgt op de eerste geldige `xx03` een lokale `0118`-tijdsopdracht voor dataloggerregister 31. Bij ontbrekende `xx04`-pakketten herhaalt de opdracht hoogstens eenmaal per tien minuten, zolang er `xx03`-pakketten binnenkomen. `time_sync_sent` logt de uitgaande bytes, `time_sync_response` logt een eventueel binnenkomend `xx18`-antwoord. `reply_sent` betekent dat Node de bytes aan de socket heeft overgedragen; controleer de daaropvolgende pakketten om het effect op de logger te zien. Nieuwe TCP-verbindingen en normale sluitingen staan tussen de berichten; na 30 minuten stilte volgt `idle_disconnect`. De listener gebruikt geen TCP-keepalive met korte probe-termijn. `DELETE /api/v1/growatt/diagnostics` wist alleen diagnostische berichten; de opbrengsthistorie blijft aanwezig door een automatische SQLite-migratie bij de eerste start van deze versie.

## Testen

`npm test` voert de offline integratietests uit voor opslag/overschrijven, daglichtquota, meerdere TCP-fragmenten/CRC/ACK/tijdcommando, meerdere verbindingen, grafiekpunten met minder dan vier omvormers, diagnostiek wissen met behoud van historie, HomeWizard-netmeting zonder dubbeltelling en een startadvies verder dan drie uur. De tests versturen niets naar externe diensten.
