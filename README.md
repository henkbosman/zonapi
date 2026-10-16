# ZonAPI — lokaal zonnestroomadvies

Node.js-dienst voor een Growatt ShineLanBox, een optionele Growatt-webbron, lokale HomeWizard-meters, Open-Meteo-instraling, een SQLite-historie, ESP32-endpoints en een dashboard. De Growatt TCP-listener ontvangt de ShineLanBox-pakketten en stuurt uitsluitend lokale protocolbevestigingen en een configureerbare tijdsynchronisatie terug. Inkomende pakketten en Growatt-opdrachten worden niet doorgestuurd. Externe verbindingen zijn de gekozen weerservice en, uitsluitend als je die inschakelt, de Growatt-web-API voor het lezen van opbrengstmetingen.

## Wat is al werkend en wat vereist controle?

- Alle softwareonderdelen, database, scheduler, HomeWizard v1/v2, API, dashboard en machineberekening zijn aanwezig. Integratietests gebruiken synthetische weer- en Growatt-pakketten.
- De Growatt-decoder gebruikt de generieke offsets uit [Grott](https://github.com/johanmeijer/grott/blob/master/grottconf.py). De ACK-volgorde, tijdopdracht en de interpretatie van de automatische `xx03`/`xx04`-rapporten zijn ook vergeleken met de onafhankelijke [growatt-protocol](https://github.com/FezVrasta/growatt-datalogger/blob/main/packages/growatt-protocol/README.md)- en [shine2mqtt](https://github.com/bremme/shine2mqtt/blob/main/docs/protocol.md)-implementaties. Bij de aangesloten ShineLanBox 7.0.0.4 zijn volgens de live-observatie `xx04`-berichten voor drie van de vier MIC 2000TL-X-omvormers ontvangen. Onbekende layouts worden in de eigen SQLite-database bewaard en als `unknown_layout` getoond. Controleer in `/growatt` het serienummer en vermogen per omvormer en vergelijk met de eigen metingen.
- De voorbeeldconfiguratie bevat lege locatie- en meteradressen; vul daarvoor je eigen instellingen in. Een ingestelde Open-Meteo-locatie en paneelverdeling zijn direct te controleren op `/weather`.

## Snel starten op Arch Linux

1. Installeer Node.js **24 of nieuwer** (`node --version`). Er zijn geen npm-pakketten of cloudopslag nodig; SQLite gebruikt `node:sqlite`.
2. Kopieer deze hele map naar de server. Pas **`config/settings.json`**, **`config/panels.json`** en desgewenst de drie bestanden in **`config/appliances/`** aan. De voorbeeldpanelen bevatten bewust geen verzonnen Wp, hellingshoek of verdeling over omvormers.
3. Start in de projectmap met `npm start` of `node src/main.js`. Open eerst `http://127.0.0.1:8080/dashboard`. De database en dagelijkse back-ups verschijnen in `data/`.
4. Stel `http.host` en `growatt.host` in op het **LAN-IP van deze Arch Linux-server**, bijvoorbeeld `192.168.1.20`, en herstart. Laat uitsluitend lokale apparaten bij de twee poorten. Plaats de API niet achter een publiek bereikbare website/proxy.
5. Voor de lokale bron stel je in de ShineLanBox-serverinstellingen **ditzelfde lokale IP en poort 5279** in. Een DNS-omleiding is niet nodig. Controleer `GET /api/v1/status` op ontvangen/gedecodeerde Growatt-pakketten en vier omvormers. Voor de tijdelijke cloudbron laat je de ShineLanBox juist weer naar de normale Growatt-server verzenden en schakel je de hieronder beschreven webbron in.
6. Vul voor P1 en kWh-meter de **eigen LAN-IP-adressen** in bij `homewizard.p1.host` en `homewizard.kwh.host`. De API leest beide onafhankelijk maar telt ze nooit bij elkaar op: het is volgens jouw informatie hetzelfde eenfasige netmeetpunt. De standaardvolgorde voor een verse actuele netmeting is P1, daarna kWh; verander `net_meter_priority` als gewenst.

Herstart na wijzigingen van `settings.json`, `panels.json` en `layouts/*.json`. Apparatenprofielen uit `config/appliances/*.json` worden opnieuw ingelezen bij elke API-aanvraag. Het dashboard maakt zichzelf elke 30 seconden opnieuw actueel.

### Bestaande installatie bijwerken

Stop de Node-dienst en bewaar een kopie van `data/zonapi.sqlite`. Kopieer voor deze versie de mappen `src/` en `public/` uit het archief naar de bestaande installatie en start de dienst opnieuw. Behoud de eigen `config/settings.json`, `config/panels.json`, `config/appliances/` en de hele `data/`-map. Pak de voorbeeldmap `data/` niet over de installatie heen uit. De bestaande database krijgt bij de eerste start extra weerdiagnosekolommen; eerdere weerpogingen, historische instraling en opbrengst blijven behouden. Als `growatt.time_sync_on_announcement` ontbreekt, staat de lokale tijdsynchronisatie standaard aan; zonder `growatt.time_sync_retry_minutes` is het herhaalinterval 10 minuten. Na een nieuwe `xx03`-aanmelding staan `reply_sent` en `time_sync_sent` in `/growatt`. De dienst verstuurt opnieuw een tijdopdracht als de vier `xx04`-adressen op die verbinding uitblijven.

Het losse dashboardupdatearchief bevat uitsluitend `src/`, `public/`, `test/` en deze README in de map `zonapi/`. Pak het uit in de **bovenliggende map** van je bestaande ZonAPI-installatie; het bevat geen configuratie of database.

Deze update voegt automatisch aparte tabellen voor Growatt-cloudmetingen en webverzoeken toe en behoudt de bestaande meet-, pakket- en weerhistorie. Bestaande instellingen blijven geldig: zonder `growatt.production_source` wordt uitsluitend de lokale ShineLink-bron gebruikt. Zonder `weather.resolution_minutes` worden kwartierwaarden opgehaald. Open na het herstarten `/dashboard`, `/growatt`, `/weather` en `/homewizard`.

### Logging en dashboard

Op `/growatt`, `/weather` en `/homewizard` schakelt **Logging aan / Logging uit** het bijbehorende logboek om. Elke bron heeft een eigen instelling die herstarts overleeft. De verwijderknop wist het bijbehorende logboek. Omvormer- en HomeWizard-metingen, instralingshistorie, voorspellingen en het gebruikte weerquotum blijven bewaard. De actuele bronstatus blijft ook met logging uit beschikbaar.

Logs staan aanvankelijk aan. Automatische opschoning houdt standaard de nieuwste 5000 regels per bron over; Growatt-pakketten, verbindingslogs en webverzoeken delen deze limiet. Opschoning vindt plaats bij starten en na elke 100 nieuwe logregels. SQLite hergebruikt de vrijgekomen pagina's. Stel optioneel `"logging": { "max_entries_per_source": 5000 }` in `settings.json` in; toegestaan is 100–100000. Deze limiet geldt uitsluitend voor diagnosegegevens.

De Zonopbrengst-grafiek toont de voorspelling van zonsopkomst tot zonsondergang, ook voor het verstreken deel van de dag. De voorspellingen worden met rechte, schuine lijnen tussen de middelpunten van hun tijdvakken verbonden. Beweeg de muis over de grafiek voor een verticale lijn met tijd, gemeten vermogen en voorspeld vermogen in watt; de getoonde waarden volgen de getekende lijnen. Meetgaten blijven onderbroken. De toetsen Home, End en de pijlen werken na focus op de grafiek. De lijn voor de huidige tijd blijft zichtbaar. De dagvoorspelling komt uit de bestaande database en doet geen extra weerverzoeken.

Het dashboard geeft per apparaat een starttijd op iedere dag van `weather.forecast_days`. De volledige cyclus moet binnen de zonuren van die dag passen. Vandaag worden alleen toekomstige starttijden gezocht. Dezelfde apparaatprofielen, basislast, reserve en minimale zonnefractie gelden als voor het bestaande ESP32-advies. Ontbrekende of verouderde gegevens worden afzonderlijk weergegeven. Het bestaande `/advice`-endpoint blijft `advice.search_hours` gebruiken; het nieuwe `/appliances/daily` gebruikt alle ingestelde voorspeldagen.

Op `/homewizard` staan host, lokale API-versie, laatste meetwaarden, import-/exporttellers, responstijd en fout per meter. De verzoekentijdlijn kan op apparaat en resultaat worden gefilterd. **Nu ophalen** leest de ingestelde lokale meters. Autorisatieheaders en tokens worden niet gelogd.

### Growatt via de web-API

De webbron gebruikt een Growatt API-token. De [Home Assistant-integratie](https://www.home-assistant.io/integrations/growatt_server/) noemt de MIC 2000TL-X als ondersteund model. Installaties en omvormers worden herkend via de v1-lijsten; de metingen worden gelezen met `POST /v4/new-api/queryLastData`. De veldnamen en eenheden volgen de [beschrijving van een v4-MIN-antwoord](https://christalma.nl/growatt-openapi/). De adapter staat afzonderlijk in `src/growatt/cloud/client.js`.

Voeg in het bestaande `growatt`-object van `config/settings.json` deze velden toe. Laat de bestaande host-, poort- en omvormerinstellingen staan:

```json
{
  "production_source": "cloud",
  "cloud": {
    "token": "JOUW_GROWATT_API_TOKEN",
    "base_url": "https://openapi.growatt.com",
    "poll_seconds": 300,
    "plant_id": "",
    "device_type": "min",
    "daylight_only": false
  }
}
```

Het token is te vinden in **ShinePhone → Me/Ik → je gebruikersnaam → API Token**. Je kunt het ook via de Growatt-website onder **Account Management → API Token** opvragen. Vul het token lokaal in; de API en het dashboard geven het niet terug. Als alternatief kun je het token via de omgevingsvariabele `GROWATT_API_TOKEN` aan Node meegeven. Die variabele gaat vóór `cloud.token`; de naam is instelbaar met `cloud.token_env`.

De bronkeuze is:

| `growatt.production_source` | Werking |
| --- | --- |
| `shinelink` | Standaard voor bestaande configuraties. Alleen lokale metingen; geen Growatt-webverzoeken. |
| `cloud` | Gebruikt de Growatt-webmetingen voor dashboard, ESP32, historie en basislast. De lokale ontvanger blijft beschikbaar. |
| `auto` | Kiest per omvormer een recente ShineLink-meting en valt anders terug op cloud. Als alle ingestelde omvormers lokaal actueel zijn, worden geen nieuwe cloudmetingen opgehaald. |

De ShineLanBox moet voor actuele cloudmetingen weer naar de **normale Growatt-server** wijzen. ZonAPI leest dan de daar ontvangen metingen; het fungeert niet als proxy. Om later terug te schakelen, wijs je de ShineLanBox weer naar `192.168.2.210:5279` en kies je `shinelink` of `auto`.

Vul de vier serienummers in `config/panels.json` in als je die kent. Zonder opgegeven serienummers herkent ZonAPI de installatie en omvormers automatisch. Bij meerdere installaties toont `/growatt` de namen en IDs; kies er dan één met `cloud.plant_id`. Laat voor automatische herkenning alle omvormerserienummers leeg. Er wordt geen willekeurige installatie gekozen. Voor deze MIC-omvormers is het gebruikelijke type `min`; `inv` is beschikbaar voor de klassieke inverterfamilie.

Er wordt standaard iedere vijf minuten opgehaald, ook zonder dashboard- of ESP32-verzoeken. `poll_seconds` is instelbaar van 300 tot 86400 seconden; zet `growatt.fresh_minutes` passend bij de gewenste meetversheid. Het interval wordt bewaard over herstarts. Bij fouten loopt de wachttijd op; HTTP `Retry-After` en Growatt-code `501` worden gerespecteerd. **Nu ophalen** op de Growatt-pagina behoudt deze wachttijd. Met `daylight_only: true` wordt alleen binnen de lokale zonuren opgehaald. `request_pause_ms` bepaalt de pauze tussen opeenvolgende webverzoeken en is standaard 1100 ms, instelbaar van 1000 tot 10000 ms.

Cloudmetingen bewaren `pac` in watt en `eacToday`/`eacTotal` in kWh, met de meettijd uit `calendar` of `time`. Een herhaald oud antwoord maakt geen nieuw actueel meetpunt. Zonder tijdzone in `time` wordt `cloud.timezone` gebruikt; standaard `Europe/Amsterdam`. De opbrengstgrafiek en basislastberekening tellen iedere omvormer eenmaal. Beide meetbronnen blijven afzonderlijk bewaard; de kalibratiefactor wordt niet op gemeten opbrengst toegepast.

Op `/growatt` staan webbronstatus, interval, vorige/volgende poging en de laatste fout. Kies **Toon → Web-API** voor de verzoeken of **Fouten** voor alle fouten. **Bekijk** toont HTTP-metadata en het geschoonde JSON-antwoord. De bestaande Growatt-logschakelaar en verwijderknop gelden ook voor deze verzoeken. Historische cloud- en ShineLink-metingen blijven behouden.

Bij systemd kun je optioneel `/etc/zonapi/growatt.env` met `GROWATT_API_TOKEN=...` gebruiken. Het meegeleverde servicesjabloon leest dit bestand. Voor een reeds geïnstalleerde service voeg je met `sudo systemctl edit zonapi` onder `[Service]` de regel `EnvironmentFile=-/etc/zonapi/growatt.env` toe. Herstart Node na het wijzigen van broninstellingen of token.

### Weerdiagnose

Open `/weather` voor de ingestelde locatie, het werkelijk opgebouwde Open-Meteo-adres, zontijden, resolutie, aanvraaggeschiedenis, HTTP-status, fouttekst en opgeslagen instraling. `Nu ophalen` slaat het normale tijdsinterval over voor één poging; daglichtgrenzen en `max_requests_per_local_day` blijven gelden. Een eerdere HTTP 400 kan als oude fout zichtbaar blijven in de geschiedenis; een nieuw verzoek slaat de volledige foutreden van Open-Meteo op.

### Kwartierprognose

ZonAPI vraagt standaard GHI, DNI en DHI per 15 minuten op via Open-Meteo. Eén gecombineerd verzoek met `models=best_match,icon_d2` haalt de native ICON-D2-kwartierwaarden en de Best-Match-uurwaarden op. De kwartierreeks vraagt 48 uur vooruit en 24 uur terug, zodat ook het verstreken deel van vandaag in de daggrafiek kan staan. Binnen de beschikbare ICON-D2-horizon van ongeveer twee dagen worden de kwartieren gebruikt; ontbrekende kwartieren en verder gelegen dagen gebruiken uurwaarden. Dit volgt de [Open-Meteo-parameterdefinities](https://open-meteo.com/en/docs) en de [ICON-D2-specificatie](https://open-meteo.com/en/docs/dwd-api).

De bronwaarden zijn gemiddelden over het voorafgaande kwartier of uur. De API zet ze om naar UTC-intervallen en rekent daarna zelf de paneelopbrengst uit. Opslag, grafieken, historie en apparaatadviezen gebruiken dezelfde selectie: nieuwere ophaaltijd gaat voor, bij gelijke ophaaltijd gaat de fijnste resolutie voor. Uur- en kwartierwaarden worden niet dubbel geteld. De oorspronkelijke intervallen en modelnamen blijven opgeslagen, ook als slechts een deel van een uur als terugval wordt gebruikt.

De bestaande daglichtplanning, daglimiet en kalibratiefactor blijven gelden; de kwartierresolutie verhoogt de ophaalfrequentie niet. Nieuwe kwartierdata komt bij de eerstvolgende geplande ophaalpoging beschikbaar, of via **Nu ophalen** op `/weather`. Daar staat onder **Resolutie vandaag** bijvoorbeeld `15 min` of `15 / 60 min`.

Optioneel kun je in de bestaande `weather`-sectie `"resolution_minutes": 15` opnemen. Met `60` wordt uitsluitend de oorspronkelijke uurvoorspelling aangevraagd, met automatische modelkeuze. Herstart Node na wijzigen. De voorspelling- en instralingendpoints geven `resolution_minutes` (fijnste bronresolutie), `resolutions_minutes` en `mixed_resolution` terug. Ieder slot bevat ook `model`, de effectieve `resolution_minutes` en de oorspronkelijke `source_resolution_minutes`.

### Growatt-teller op nul

Open `/growatt` en lees `TCP`, `Database` en `Ontvangen pakketten`; dezelfde velden staan in `GET /api/v1/growatt` (`listener`, `database_path`, `summary.frames_total`). De teller leest de actieve SQLite-database; hij wordt ook nul na de knop **Berichten en logs verwijderen**. Historische vermogensmetingen blijven dan wel bestaan. De TCP-status is `true` als poort 5279 werkelijk luistert. Bij `false` geeft `listener.last_error` de foutcode, bijvoorbeeld `EADDRINUSE` of `EADDRNOTAVAIL`. Als hij luistert maar er geen nieuwe berichten zijn, controleer in `GET /api/v1/growatt/timeline?view=events&limit=20` of er TCP-verbindingen worden geopend. Op de server:

```sh
curl -s http://192.168.2.210:3002/api/v1/growatt
sudo ss -ltnp '( sport = :5279 )'
sudo journalctl -u zonapi -n 50 --no-pager
```

Vergelijk `database_path` met het databasebestand van de bestaande installatie. Als een nieuwe installatiemap is gebruikt, start de dienst dan weer vanuit de oorspronkelijke map met zijn bestaande `data/`-map.

### Instellingen

| Bestand/veld | Vul in / werking |
| --- | --- |
| `settings.json > location` | Breedte- en lengtegraad van je locatie. Er wordt vóór dit is ingevuld geen extern weerverzoek gedaan. |
| `settings.json > pv.calibration_factor` | Optioneel; standaard `1.0`. Vermenigvuldigt de berekende paneelopbrengst vóór begrenzing per omvormer. Een getal >0 en <=10; bijvoorbeeld `1.78` voor 78% meer opbrengst. |
| `settings.json > logging.max_entries_per_source` | Optioneel; standaard 5000 diagnostische regels per bron. Logschakelaars worden via het dashboard in de database bewaard. |
| `settings.json > http` | LAN-IP en HTTP-poort voor ESP32's/dashboard. Begint uit voorzorg op `127.0.0.1`. |
| `settings.json > growatt` | LAN-IP/poort voor ShineLanBox; standaard 5279, verwacht vier omvormers. `idle_timeout_minutes` is standaard 30 (instelbaar 1–120). `time_sync_on_announcement` is standaard `true`, ook in bestaande configuraties zonder dit veld. `time_sync_retry_minutes` is standaard 10 (instelbaar 1–120). |
| `settings.json > growatt.production_source` | Optioneel; `shinelink` (standaard), `cloud` of `auto`. |
| `settings.json > growatt.cloud` | Token of `token_env`, HTTPS-serveradres, optionele installatie-ID, interval en daglichtkeuze voor de Growatt-webbron. Zie de web-API-instructies hierboven. |
| `settings.json > weather.max_requests_per_local_day` | Standaard 12, instelbaar 0–48; `0` pauzeert de externe bron. Een mislukte poging telt mee; teller overleeft herstart. Alleen tussen zonsopkomst en zonsondergang, met minimaal ongeveer één uur tussen normale pogingen. |
| `settings.json > weather.forecast_days` | Standaard 3, instelbaar 2–16; verleng als het adviesvenster veel langer dan 24 uur wordt. Buiten de native kwartierhorizon worden uurwaarden gebruikt. |
| `settings.json > weather.resolution_minutes` | Optioneel; standaard `15`. Vraagt kwartierwaarden met uurterugval op; `60` vraagt uitsluitend uurwaarden op. |
| `settings.json > advice.search_hours` | Standaard 24; advies controleert ook de **volledige** cyclus voorbij dat laatste starttijdstip. |
| `settings.json > advice.min_solar_share` | Standaard `0.7` (70% van de voorspelde apparaatenergie uit eigen opwek). Apparaten mogen een eigen `min_solar_share` hebben; netafname blijft mogelijk. |
| `settings.json > advice.reserve_w` | Vermogensmarge bovenop de geschatte huisbasislast, standaard 300 W. |
| `settings.json > advice.baseload_w` | `null` leert een voorzichtige basislast uit minstens 12 uitgelijnde netto- en vier omvormermetingen; of stel zelf een bekende constante in. De P1 is primair, de kWh-meter kan als alternatieve historie dienen. |
| `panels.json > groups` | Eerst 20 panelen op het zuiden (`azimuth_deg: 180`), maar **Wp, helling en omvormertoewijzing moeten worden ingevuld**. Splits een groep in meerdere richtingen door meerdere regels te maken; de aantallen tellen op tot 20. |
| `appliances/*.json` | Elk apparaat heeft `steps` met `duration_minutes` en `power_w`, en optioneel eigen `reserve_w` en `min_solar_share`. De meegeleverde 90/150/210 minuten en wattages zijn **schattingen**, te vervangen door eigen metingen. |

Een enkele groep van 20 panelen heeft geen echte `inverter_id` totdat je weet hoe de panelen verdeeld zijn. Maak vervolgens bijvoorbeeld groepen per omvormer met id `mic-1` … `mic-4`, en zet per groep het juiste aantal, `wp_per_panel` en `tilt_deg` in `panels.json`. Er worden geen extra weerserviceverzoeken gedaan als je later een deel naar oost of west verlegt: één GHI/DNI/DHI-reeks wordt lokaal omgerekend naar ieder paneelvlak. Vul de vier echte omvormerserienummers in `inverters[].serial` in wanneer ze bekend zijn; daarna worden onbekende serienummers niet in de actuele totaalsom opgenomen.

### Opbrengst kalibreren

Voeg op hoofdniveau aan je bestaande `config/settings.json` de sectie `"pv": { "calibration_factor": 1.78 }` toe en herstart Node. Laat je overige instellingen staan. Een factor van `1.0` geeft de oorspronkelijke berekening; `1.78` maakt 208 W ongeveer 370 W; `0.9` verlaagt de uitkomst met 10%. Voor een volgende bijstelling vermenigvuldig je de bestaande factor met `gemeten / voorspeld`.

Dezelfde factor geldt voor de daggrafiek, de drie-uurs-API, de opgeslagen PV-voorspellingen en alle apparaatadviezen. De AC-limiet blijft per omvormer gelden. Instraling, GTI en ontvangen Growatt- en HomeWizard-metingen worden niet vermenigvuldigd. Na herstart worden lopende en toekomstige PV-cachewaarden opnieuw berekend uit de opgeslagen instraling, zonder extra weerverzoek en met behoud van de oorspronkelijke ophaaltijd. De voorspellingendpoints vermelden de toegepaste `calibration_factor`.

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
| `GET /api/v1/forecast/day` | Voorspelling voor de volledige dag uit de cache, met zonsopkomst/-ondergang en aangrenzende tijdvakken voor het aansluiten van de grafieklijn op de daggrenzen. |
| `GET /api/v1/irradiance?hours=3` | Instraling per kwartier met uurterugval en berekende GTI per paneelgroep. |
| `GET /api/v1/production/current` | Afzonderlijke omvormers plus uitsluitend bij vier verse metingen een betrouwbare som. |
| `GET /api/v1/production/day` | Beschikbare omvormermetingen van vandaag, samengevoegd op meettijd, met het aantal actieve omvormers per punt en zonsopgang/-ondergang. |
| `GET /api/v1/growatt?limit=50` | Feitelijke TCP-luisterstatus/fout, actieve databasepad, ontvangen pakkettypen/statussen, omvormers en recente fouten; maximaal 100 pakketten per aanvraag. |
| `GET /api/v1/growatt/cloud` | Webbronstatus en herkende installaties/omvormers zonder token. |
| `POST /api/v1/growatt/cloud/poll` | Eén ophaalpoging als het ingestelde interval en eventuele foutwachttijd verstreken zijn. |
| `GET /api/v1/growatt/cloud/calls/:id` | HTTP-metadata en geschoond JSON-antwoord van één opgeslagen webverzoek. |
| `GET /api/v1/weather?status=all&limit=50&offset=0` | Weerstatus, aangemaakte aanvraag-URL, zoninstraling van vandaag en gefilterde, pagineerbare aanvragen met HTTP-status en foutreden. Statusfilter: `all`, `ok`, `error`, `pending`. |
| `POST /api/v1/weather/refresh` | Probeert direct eenmaal het weer op te halen als er daglicht en dagelijks quotum beschikbaar is; resultaat bevat `attempted`, `reason` en bijgewerkte status. |
| `GET /api/v1/:source/logging` | Logstatus voor `growatt`, `weather` of `homewizard`. |
| `PUT /api/v1/:source/logging?enabled=false` | Logging uitzetten; `enabled=true` zet logging aan. |
| `DELETE /api/v1/weather/diagnostics` | Wist weerlogs met behoud van dagquotum, planning, instraling en actuele status. |
| `GET /api/v1/homewizard?device=all&status=all&limit=50&offset=0` | Lokale meterinformatie, actuele bronstatus en gefilterde verzoeken. `device`: `all`, `p1`, `kwh`; `status`: `all`, `ok`, `error`. |
| `POST /api/v1/homewizard/poll` | Leest eenmaal de ingestelde lokale meters. |
| `DELETE /api/v1/homewizard/diagnostics` | Wist meterlogs met behoud van meetgeschiedenis en actuele status. |
| `GET /api/v1/growatt/timeline?type=xx04&limit=100` | Chronologische lijst van pakketten, TCP-gebeurtenissen en webverzoeken, met filters `type` (`xx04` of `5004`), `address` (`50`–`53`), `view` (`all`, `packets`, `errors`, `events`, `cloud`) en paginering via `offset`. `has_more` geeft aan of er meer regels zijn. |
| `GET /api/v1/growatt/frames/:id` | Eén ontvangen pakket inclusief de oorspronkelijke hex-inhoud en eventuele gedecodeerde meting. |
| `DELETE /api/v1/growatt/diagnostics` | Verwijdert Growatt-pakketten en verbindings-/antwoordlogs, behoudt opgeslagen opbrengstmetingen; geeft verwijderde aantallen terug. De Growatt-pagina biedt hiervoor een knop met bevestiging. |
| `GET /api/v1/meters/current` | P1 en kWh afzonderlijk, plus precies **één** gekozen netto netvermogen. Positief = import, negatief = export. |
| `GET /api/v1/history?metric=irradiance&from=...&to=...` | Bestaande time series. `metric`: `irradiance`, `pv_forecast`, `inverter`, `p1` of `kwh`; `limit` max. 5000. Bij `inverter` kiest optioneel `source=shinelink`, `cloud` of `auto` de bron; standaard geldt de ingestelde opbrengstbron. Bij voorspellingen overschrijft een nieuwere bronwaarde hetzelfde tijdvak. |
| `GET /api/v1/appliances` | Geldige JSON-profielen en eventuele laad-/validatiefouten. |
| `GET /api/v1/appliances/daily` | Per voorspelde lokale dag zontijden en startadviezen voor alle apparaatprofielen. |
| `GET /api/v1/appliances/wasmachine/advice` | `can_start_now`, `earliest_start`, `best_start`, volledige zonnefractie en status (`ok`, `stale`, `forecast_incomplete`, enzovoort). Ook `droger` en `vaatwasser`. |
| `GET /api/v1/status` | Bronnen, configuratiefouten, historisch aantal ontvangen frames, zontijden, gebruikt/dagmaximum en volgende weersophaling. |
| `GET /dashboard` | Gemeten opbrengst en de volledige dagvoorspelling tussen zonsopkomst en zonsondergang, schuine verbindingen tussen voorspeltijdvakken, huidige-tijdlijn en tijd-/waardecursor; toont ook de beschikbare metingen bij minder dan vier omvormers. |
| `GET /growatt` | Growatt-pagina met omvormermetingen, tijdlijn voor pakketten, antwoorden, tijdsynchronisatie en verbindingen, filters, verwijderknop en verversing iedere 15 seconden. |
| `GET /weather` | Weerpagina met zontijden, bronverzoeken, fouten, instralingsgrafiek en handmatige ophaalknop, verversing iedere 15 seconden. |
| `GET /homewizard` | Lokale meterinformatie, poll-logs, filters, logbeheer en handmatig ophalen; verversing iedere 15 seconden. |

Bijvoorbeeld voor een ESP32: lees `can_start_now` alleen als `status === "ok"`; bij `null`, `stale` of ontbrekende instellingen toon je "onbekend" in plaats van "nee". `earliest_start` kan na drie uur liggen. `best_start` laat de beste optie zien als de drempel nergens wordt gehaald.

## Growatt-validatie bij eerste live-verbinding

1. Laat de dienst eerst lokaal draaien, verplaats daarna het ingestelde ShineLanBox-serveradres. De decoder ontvangt op de ingestelde TCP-poort; de software heeft geen uitgaand Growatt-adres en gebruikt geen proxy.
2. Bekijk `/api/v1/status`: `frames` toont `decoded:...`, `unknown_layout`, `bad_crc` en dergelijke; de individuele omvormers staan er met meettijd. In `config/layouts/README.md` staat het schema voor alternatieve layouts.
   Via `/growatt` zijn de berichttypen, ontvangen bytes en TCP-gebeurtenissen direct in de browser te bekijken. Kies `xx04` om ook eerdere meetpakketten te vinden die niet bij de laatste honderd berichten staan. De knop Vernieuwen en het tijdstip Bijgewerkt tonen of nieuwe gegevens zijn opgehaald. De hex-inhoud kan serienummers bevatten.
   ShineLanBox-v06-aanmeldingen met type `5003`–`5303` of `5029`–`5329` tonen de adressen `50`–`53`, omvormerserienummers en logger. Open een `xx29`-pakket met **Bekijk** om per RF-stick het update-interval, de firmware, tijdzone en apparaatklok te lezen. In de vier verstrekte voorbeelden meldt adres `50` 5 minuten en melden adressen `51`–`53` elk 1 minuut. Deze pakketten bevatten geen actuele vermogensmeting; daarvoor is een datarecord nodig (`xx04` of `xx50`).
3. Vergelijk meerdere werkelijk gemeten wattages en energietellers **per serienummer** met de eigen omvormers. Controleer herverbinding en of oudere gebufferde pakketten niet het actuele vermogen vervangen. Gebruik desgewenst lokaal `node scripts/inspect-frames.js` voor pakketstatus; `--hex` toont privégegevens, waaronder serienummers.
4. Bij uitsluitend lokaal gebruik kun je externe Growatt-verbindingen met de firewall blokkeren. Voor cloudgebruik moet de ShineLanBox Growatt wel kunnen bereiken. De TCP-ontvanger stuurt in geen van beide standen pakketten of cloudopdrachten door. Of jouw ShineLanBox 7.0.0.4 de generieke ACK van de lokale TCP-server accepteert, kan pas met de echte hardware worden bevestigd. Als dat niet zo is, zijn de bewaarde pakketten de input voor een gerichte protocolaanpassing.

Een ontvangen `5004` verschijnt als omvormermeting onder het serienummer van adres `50`. De totale actuele opbrengst in de API wordt pas gevuld wanneer alle vier omvormers een recente `xx04`-meting hebben; de grafiek tekent ook beschikbare deelmetingen en vermeldt hoeveel omvormers meetelden. Bekijk na elk bericht `reply_sent` in `/growatt` voor de lokaal geschreven antwoordbytes. ZonAPI schrijft de ACK vóór het decoderen; direct daarna volgt op de eerste geldige `xx03` een lokale `0118`-tijdsopdracht voor dataloggerregister 31. Bij ontbrekende `xx04`-pakketten herhaalt de opdracht hoogstens eenmaal per tien minuten, zolang er `xx03`-pakketten binnenkomen. `time_sync_sent` logt de uitgaande bytes, `time_sync_response` logt een eventueel binnenkomend `xx18`-antwoord. `reply_sent` betekent dat Node de bytes aan de socket heeft overgedragen; controleer de daaropvolgende pakketten om het effect op de logger te zien. Nieuwe TCP-verbindingen en normale sluitingen staan tussen de berichten; na 30 minuten stilte volgt `idle_disconnect`. De listener gebruikt geen TCP-keepalive met korte probe-termijn. `DELETE /api/v1/growatt/diagnostics` wist alleen diagnostische berichten; de opbrengsthistorie blijft aanwezig door een automatische SQLite-migratie bij de eerste start van deze versie.

## Testen

`npm test` voert de offline integratietests uit voor de Growatt-webadapter en tokenafscherming, bronkeuze zonder dubbeltelling, cloudhistorie/basislast, foutterugval en herstart, kwartiernormalisatie, modelkeuze, gemengde resoluties, database-migratie en overschrijven, daglichtquota, meerdere TCP-fragmenten/CRC/ACK/tijdcommando, meerdere verbindingen, grafiekpunten met minder dan vier omvormers, vaste daglichtgrenzen en grafiekcursor, begrensde logs en uitschakelen met behoud van metingen/quota, HomeWizard-diagnose en dagadviezen rond wintertijd. De tests versturen niets naar externe diensten; de webadapter gebruikt gedocumenteerde antwoordfixtures, geen live Growatt-account.
