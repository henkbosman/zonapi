# ZonAPI — lokaal zonnestroomadvies

Node.js-dienst voor een Growatt ShineLanBox, een optionele Growatt-webbron, lokale HomeWizard-meters, Open-Meteo-instraling, een SQLite-historie, ESP32-endpoints en een dashboard. De Growatt TCP-listener ontvangt de ShineLanBox-pakketten en stuurt uitsluitend lokale protocolbevestigingen en een configureerbare tijdsynchronisatie terug. Inkomende pakketten en Growatt-opdrachten worden niet doorgestuurd. Externe verbindingen zijn de gekozen weerservice en, uitsluitend als je die inschakelt, de Growatt-web-API voor het lezen van opbrengstmetingen.

## Wat is al werkend en wat vereist controle?

- Alle softwareonderdelen, database, scheduler, HomeWizard v1/v2, API, dashboard en machineberekening zijn aanwezig. Integratietests gebruiken synthetische weer- en Growatt-pakketten.
- De Growatt-decoder gebruikt de generieke offsets uit [Grott](https://github.com/johanmeijer/grott/blob/master/grottconf.py). De ACK-volgorde, tijdopdracht en de interpretatie van de automatische `xx03`/`xx04`-rapporten zijn ook vergeleken met de onafhankelijke [growatt-protocol](https://github.com/FezVrasta/growatt-datalogger/blob/main/packages/growatt-protocol/README.md)- en [shine2mqtt](https://github.com/bremme/shine2mqtt/blob/main/docs/protocol.md)-implementaties. Bij de aangesloten ShineLanBox 7.0.0.4 zijn volgens de live-observatie `xx04`-berichten voor drie van de vier MIC 2000TL-X-omvormers ontvangen. Onbekende layouts worden in de eigen SQLite-database bewaard en als `unknown_layout` getoond. Controleer in `/intern/growatt` het serienummer en vermogen per omvormer en vergelijk met de eigen metingen.
- De voorbeeldconfiguratie bevat lege locatie- en meteradressen; vul daarvoor je eigen instellingen in. Een ingestelde Open-Meteo-locatie en paneelverdeling zijn direct te controleren op `/intern/weather`.

## Snel starten op Arch Linux

1. Installeer Node.js **24 of nieuwer** (`node --version`). Er zijn geen npm-pakketten of cloudopslag nodig; SQLite gebruikt `node:sqlite`.
2. Kopieer deze hele map naar de server. Pas **`config/settings.json`**, **`config/panels.json`** en desgewenst de drie bestanden in **`config/appliances/`** aan. De voorbeeldpanelen bevatten bewust geen verzonnen Wp, hellingshoek of verdeling over omvormers.
3. Start in de projectmap met `npm start` of `node src/main.js`. Open eerst `http://127.0.0.1:3002/dashboard`. De database en dagelijkse back-ups verschijnen in `data/`.
4. Voor Caddy op dezelfde server blijft `http.host` op `127.0.0.1` en staat `http.port` op `3002`. Stel voor de lokale Growatt-ontvanger `growatt.host` in op het **LAN-IP van deze server**. Publiceer alleen het dashboard via de meegeleverde Caddyfile; de volledige API en beheerpagina's staan onder `/intern` en worden daar geblokkeerd.
5. Voor de lokale bron stel je in de ShineLanBox-serverinstellingen **ditzelfde lokale IP en poort 5279** in. Een DNS-omleiding is niet nodig. Controleer `GET /intern/api/v1/status` op ontvangen/gedecodeerde Growatt-pakketten en vier omvormers. Voor de tijdelijke cloudbron laat je de ShineLanBox juist weer naar de normale Growatt-server verzenden en schakel je de hieronder beschreven webbron in.
6. Vul voor P1 en kWh-meter de **eigen LAN-IP-adressen** in bij `homewizard.p1.host` en `homewizard.kwh.host`. De API leest beide onafhankelijk maar telt ze nooit bij elkaar op: het is volgens jouw informatie hetzelfde eenfasige netmeetpunt. De standaardvolgorde voor een verse actuele netmeting is P1, daarna kWh; verander `net_meter_priority` als gewenst.

Herstart na wijzigingen van `settings.json`, `panels.json` en `layouts/*.json`. Apparatenprofielen uit `config/appliances/*.json` worden opnieuw ingelezen bij elke API-aanvraag. Het dashboard maakt zichzelf elke 30 seconden opnieuw actueel.

## Dashboard extern, beheer intern

De openbare pagina's `/` en `/dashboard` tonen uitsluitend het dashboard. Hun JavaScript leest één `GET /api/v1/dashboard`-snapshot. Die wordt met expliciet toegestane velden opgebouwd. Apparaat-IP's, serienummers, model-/configuratiesleutels, databasepaden, ruwe antwoorden, omvormerdetails en volledige configuratie- of foutmeldingen worden niet gepubliceerd. De zichtbare kwartiercorrecties, drie meettotalen, basislast, actuele apparaten, startadviezen en cyclusgrafieken blijven beschikbaar. Een fout in de openbare route geeft een algemene melding.

Growatt, Weer, HomeWizard en Database staan op `/intern/growatt`, `/intern/weather`, `/intern/homewizard` en `/intern/database`. Ook hun scripts, stylesheets en alle volledige API-routes staan onder `/intern`. Het openbare dashboard heeft geen beheermenu. De oude adressen zoals `/growatt`, `/database` en `/api/v1/status` geven geen toegang meer. Alle bedieningsacties, waaronder ophalen, logbeheer en wissen, werken alleen via `/intern/api/v1/...`.

De meegeleverde [Caddyfile](Caddyfile) is ingesteld voor **zon.ferion.nl → 127.0.0.1:3002**. Vervang daarmee het bestaande siteblok voor dit domein; behoud de overige domeinen en globale Caddy-instellingen. De configuratie laat alleen de expliciete dashboardpaden met methode GET door. `/intern`, `/intern/*`, oude API-adressen, overige bestanden en schrijfmethoden krijgen via het domein HTTP 403. Verzoeken blijven hun volledige pad houden; er wordt geen prefix gestript.

Controleer en herlaad Caddy op je eigen server:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Voorbeeldcontroles, na installatie:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://zon.ferion.nl/dashboard
curl -s -o /dev/null -w '%{http_code}\n' https://zon.ferion.nl/intern/database
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/intern/database
```

Verwachte codes: **200, 403, 200**. De code en tests zijn lokaal gecontroleerd; Caddy moet op de doelserver met bovenstaand commando worden gevalideerd.

De interne routes hebben geen eigen inlogscherm. Ze blijven bereikbaar via de directe dienst op de server: `http://127.0.0.1:3002/intern`. Vanuit een andere computer kun je een SSH-tunnel gebruiken:

```bash
ssh -N -L 13002:127.0.0.1:3002 gebruiker@server
```

Open daarna `http://127.0.0.1:13002/intern`. Met deze Caddyfile is `/intern` via het publieke domein ook voor lokale bezoekers geblokkeerd. Een bestaande rechtstreekse LAN-toegang werkt alleen als ZonAPI daarvoor expliciet luistert; voorkom dat die poort vanaf internet toegankelijk is. Vertrouw voor toegang tot intern beheer niet op door de bezoeker aangeleverde proxyheaders. Zonder aanvullende authenticatie is het openbare dashboard voor iedereen met het adres bereikbaar.

### Bestaande installatie bijwerken

Stop de Node-dienst en kopieer `src/` en `public/` uit het archief naar de bestaande installatie. Behoud de eigen `config/settings.json`, `config/debug.json`, `config/panels.json`, `config/appliances/` en database in `data/`. Start daarna Node opnieuw. Ontbreekt `config/debug.json`, dan wordt het automatisch aangemaakt met alle logboeken uitgeschakeld. De bestaande database en kwartiercorrecties blijven in gebruik.

Het losse dashboardupdatearchief bevat `src/`, `public/`, `test/`, `examples/`, `Caddyfile`, `VERSIE.txt` en deze README in de map `zonapi/`. Pak het uit in de **bovenliggende map** van je bestaande ZonAPI-installatie; het bevat geen configuratie of database. Bestaande apparaatprofielen met één `steps`-lijst blijven werken als programma **Standaard**. Voeg meerdere programma's desgewenst zelf toe aan je eigen apparaatbestanden zoals hieronder beschreven.

Deze update haalt Growatt op vaste vijfminutenmomenten op. Iedere Open-Meteo-kwartiercorrectie gebruikt drie volledige meetmomenten op vijf minuten vóór, rond en vijf minuten na de bronklok, met herkenning van één duidelijke uitschieter. Het apparaatadvies met Meeste zon, de actieve apparaten, cyclusgrafieken, rode basislastlijn en socketherkenning blijven beschikbaar. Bestaande instellingen blijven geldig: zonder `growatt.production_source` wordt uitsluitend de lokale ShineLink-bron gebruikt. Zonder `weather.resolution_minutes` worden kwartierwaarden opgehaald. Een oude `weather.forecast_days` van `2` wordt bij het laden verhoogd tot `3`.

### Logging en dashboard

Alle loginstellingen staan in **`config/debug.json`**:

```json
{
  "logging": {
    "growatt": false,
    "weather": false,
    "homewizard": false,
    "max_entries_per_source": 5000
  }
}
```

Zet per bron `true` om te loggen en `false` om logging uit te zetten. Bestandswijzigingen worden direct gelezen, zonder herstart. Op `/intern/growatt`, `/intern/weather` en `/intern/homewizard` schrijft **Logging aan / Logging uit** dezelfde instelling naar `debug.json`. Het bestand bepaalt ook na een databasevervanging de actieve logschakelaars. De vroegere `logging`-instelling in `settings.json` wordt niet meer gebruikt. Bij een onleesbaar of ongeldig debugbestand tijdens bedrijf stopt de diagnoseopslag; de logstatus geeft de configuratiefout terug.

De verwijderknop wist het bijbehorende logboek. Omvormer- en HomeWizard-metingen, instralingshistorie, voorspellingen, kwartiercorrecties en de weeropvraagteller en planning blijven bewaard. De actuele bronstatus blijft ook met logging uit beschikbaar.

Logs staan aanvankelijk uit. Bij ingeschakelde logging houdt automatische opschoning standaard de nieuwste 5000 regels per bron over; Growatt-pakketten, verbindingslogs en webverzoeken delen deze limiet. Opschoning vindt plaats bij starten en na elke 100 nieuwe logregels. SQLite hergebruikt de vrijgekomen pagina's. `logging.max_entries_per_source` in `debug.json` is instelbaar van 100 tot 100000.

Het blok **Startadvies per dag** staat boven de drie Zonopbrengst-grafieken: **Vandaag**, **Morgen** en **Overmorgen**. Elke daggrafiek is inclusief de weericonenrij 400 pixels hoog en gebruikt de eigen zonsopkomst en zonsondergang. Vandaag blijft ook de voorspelling voor het verstreken deel van de dag zichtbaar. De voorspellingen worden met rechte, schuine lijnen tussen de **eindtijden** van hun tijdvakken verbonden. Gele punten staan daarmee op de Open-Meteo-bronklok, bij kwartierdata op :00/:15/:30/:45. Het blijven gemiddelden over het voorafgaande tijdvak. De gemeten lijn van vandaag toont uitsluitend de totale opbrengst van alle ingestelde omvormers en verbindt de totaalpunten, ook bij langere meetintervallen. Een onvolledige nieuwe meetronde wordt niet met overgenomen waarden uit de vorige ronde tot een volledig punt aangevuld. Alleen recente waarden tellen in een totaal mee: voor ShineLink geldt `growatt.fresh_minutes`, voor cloudmetingen minimaal 20 minuten (zie hieronder). De kaart **Zonnepanelen nu** en de grafiek **Gemeten opwek** gebruiken eveneens totalen.

Bovenaan iedere daggrafiek staat een **weericoon per zichtbaar klokkwartier**: een zon voor **Helder**, zon met wolk voor **Deels bewolkt** en een wolk voor **Bewolkt**. Het echte veld `cloud_cover` bepaalt het icoon: **0% helder**, **meer dan 0% en minder dan 80% deels bewolkt**, **80–100% bewolkt**. Een ontbrekend of ongeldig percentage toont **?**. De algemene weercode bepaalt dit bewolkingsicoon niet: die kan ook mist, regen of sneeuw beschrijven. De strengere nulbewolkingscontrole voor nieuwe correcties blijft afzonderlijk gelden.

De iconen worden gekoppeld aan het **dichtstbijzijnde oorspronkelijke uurpunt bij het midden van het kwartier**. Er wordt geen kwartierbewolking geïnterpoleerd of een ontbrekend uur ingevuld. De tooltip noemt het kwartier, de weersituatie, het beschikbare bewolkingspercentage, datum/tijd van de gebruikte uurverwachting, het gekozen model, de ophaaltijd en de ruwe weercode. Een te oude waarde krijgt de melding **Verouderde weerdata** volgens `weather.stale_after_hours`. De ophaaltijd is de ontvangsttijd van het antwoord, niet de starttijd van de modelrun; opnieuw ophalen kan dezelfde modelverwachting opleveren. De tijdcursor toont ook de weersituatie. Uurpunten bij de wintertijdwisseling blijven door hun verschillende UTC-tijd afzonderlijk. De oorspronkelijke modelgegevens zijn een verwachting, geen lokale bewolkingsmeting.

Ieder kwartier krijgt minimaal 18 pixels horizontale ruimte. Waar nodig kun je de grafiek **horizontaal schuiven**; de weericonen en de vermogenslijnen blijven op dezelfde tijdas. De popup blijft binnen het zichtbare deel en bij toetsenbordbediening schuift het gekozen tijdstip mee in beeld. De bestaande Open-Meteo-opvraag en opgeslagen bewolkingspunten leveren alle gegevens; er zijn geen extra weerverzoeken, instellingen of databasemigratie nodig. De dag-API en openbare snapshot bevatten `conditions` met `resolution_minutes: 60`, `time_basis: "instant"` en `rows` met tijd, bewolkingspercentage, weercode, icooncategorie, `fetched_at`, `stale` en een afgeschermd `weather_model` (`icon_d2`, `best_match` of `unknown`). Alleen deze vaste weermodelnamen worden openbaar toegevoegd; locatie, interne modellen/configuratiesleutels en onvoorziene modelnamen blijven afgeschermd.

**Analyse van de bewolkingsmelding, versie 2026-10-20-BewolkingFix1.** De vorige weergave leidde het icoon uitsluitend af uit `weather_code` en negeerde daarvoor `cloud_cover`. De [Open-Meteo-definitie](https://open-meteo.com/en/docs#hourly-parameter-definition) beschrijft `cloud_cover` als bewolkingsfractie en `weather_code` als algemene weersituatie. De [broncode voor de weercode](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Helper/WeatherCode.swift) geeft mist en neerslag voorrang boven de bewolkingsklasse. Die code is daarom niet voldoende om de hoeveelheid bewolking weer te geven. De grens van 80% voor het wolkicoon is expliciet; voor volledig helder houdt ZonAPI exact 0% aan.

Verder negeerde de parser `cloud_cover_icon_d2` en `weather_code_icon_d2`, terwijl de kwartierinstraling wel uit ICON-D2 kon komen. Nu wordt per uur de modeldekking van de instraling gecontroleerd. Waar ICON-D2-kwartierinstraling én een geldig bewolkings-/weercodepaar beschikbaar zijn, worden beide weervelden uit ICON-D2 gebruikt. Anders wordt een volledig Best Match-paar gebruikt. Twee onvolledige modellen of verschillende antwoordvormen worden nooit samengevoegd tot een schijnbaar heldere hemel. De bestaande API-opvraag bevat beide modellen al; het verzoek en het ingestelde ophaalinterval veranderen niet. In uurmodus blijft de standaard Best Match-keuze gelden.

De regressietests gebruiken onder meer bewust uiteenlopende bronwaarden: Best Match 100%/code 3 en ICON-D2 0%/code 0 bij geldige kwartierinstraling. De oude parser koos 100%; de nieuwe kiest de bijpassende 0%. Een volledige simulatie doorloopt weeropvraag, opslag, bewolkingscontrole en directe kwartiercorrectie. Afzonderlijke tests controleren bijvoorbeeld 50% met code 3: het icoon wordt deels bewolkt, terwijl de strikte correctiecontrole geen goedkeuring geeft. Tijdstippen blijven oorspronkelijke UTC-uurpunten; de koppeling aan het kwartiermidden en beide wintertijduren is gecontroleerd.

De actuele installatie en het ruwe Open-Meteo-antwoord van de gebruiker konden bij deze analyse niet rechtstreeks worden uitgelezen. De gebruiker bevestigde dat de tooltip een percentage boven nul meldde. De gevonden codeproblemen zijn aantoonbaar hersteld; dit bewijst niet dat de huidige modelverwachting op de werkelijke locatie juist is. Een model kan ook na de aanpassing bewolking voorspellen terwijl de lokale lucht helder is. Controleer bij zo'n afwijking het nu zichtbare percentage, model, uurpunt en ophaaltijd, plus de ingestelde locatie op de interne Weer-pagina.

Na bijwerken worden bestaande opgeslagen bewolkingspunten gebruikt totdat een geslaagde weeropvraag ze vervangt. Kies desgewenst eenmaal **Nu ophalen** op `/intern/weather`. Daardoor wordt de nieuwe modelkeuze direct actief. Bestaande correcties, meetgeschiedenis, instellingen en schema 7 blijven behouden.

De rode horizontale lijn toont de **basislast**, gelijk aan de basislast die het apparaatadvies gebruikt. `advice.reserve_w` is daar niet bij opgeteld. De waarde staat in de legenda en bij de cursor. Bij `advice.baseload_w: null` wordt de beschikbare automatische schatting gebruikt; zolang die ontbreekt, verschijnt er geen lijn en staat in de legenda **Basislast ontbreekt**. De schaal houdt ook rekening met een basislast die hoger is dan de hele voorspelling.

Alle drie de Zonopbrengst-grafieken tonen de voorspelling **zonder automatische correctie** als een dunne lichtgele lijn achter de gecorrigeerde gele lijn. Deze basisvoorspelling bevat wel de ingestelde handmatige kalibratie. De schaal omvat beide lijnen. De mouseover toont beide vermogens en **Correctie**, bijvoorbeeld `-20%`, `0%` of `+35%`. Dit percentage hoort bij de toegepaste automatische factor; een vermogenslimiet van de omvormer kan de uiteindelijke stijging beperken. Op een geel punt staat het percentage ook in de punttooltip. Tussen punten volgen de vermogenswaarden de rechte grafieklijn; het correctiepercentage hoort uitsluitend bij het eigen tijdvak en wordt niet met de factor van een buurblok gemengd. Historische basiswaarden en correcties worden uit dezelfde opgeslagen voorspelling gelezen als de gele lijn.

De popup en de punttooltip van de gele voorspelling tonen ook **Correctie berekend** met de datum en tijd van de laatste berekening van de toegepaste kwartiercorrectie, in **Europe/Amsterdam**. Bij hergebruik van een eerdere meetdag blijft de oorspronkelijke berekendatum zichtbaar, ook voor morgen en overmorgen. Dit is het opgeslagen berekentijdstip, niet de meettijd van het kwartier of de laatste weeropvraag. Zonder toegepaste correctie toont de popup `—`; ook een berekende correctie van 0% heeft een eigen datum.

De groepeertijd is standaard 60 seconden voor ShineLink en gelijk aan `growatt.cloud.poll_seconds` voor de cloudbron of automatische bronkeuze. Met het optionele `growatt.overview_group_seconds` kun je deze tijd aanpassen (1–86400 seconden). Dit verandert uitsluitend de groepering in het overzicht; alle oorspronkelijke omvormermetingen blijven bewaard. Beweeg de muis over een grafiek voor een verticale lijn met tijd en voorspeld vermogen in watt; vandaag wordt ook het gemeten totaalvermogen getoond. De waarden volgen de getekende lijnen. De toetsen Home, End en de pijlen werken na focus op de grafiek. Binnen de zonuren van vandaag blijft de lijn voor de huidige tijd zichtbaar. De drie dagvoorspellingen komen uit één cache-aanvraag en veroorzaken geen extra weerverzoeken. Handmatige kalibratie en geleerde kwartiercorrecties gelden voor alle drie de grafieken.

**Tijdas en kwartierpunten.** Open-Meteo definieert de gebruikte instraling als een gemiddelde over het voorafgaande kwartier of uur ([brondefinitie](https://open-meteo.com/en/docs#15_minutely_parameter_definition)). De adapter leest een waarde met bronklok 14:15 dus correct als het tijdvak 14:00–14:15. De vroegere grafiek zette die waarde vervolgens op het midden, 14:07:30; bij uurdata ontstond een verschuiving van 30 minuten. De grafiek gebruikt nu de eindtijd. De zonstandberekening gebruikt nog steeds het bronmiddelpunt, passend bij het gemiddelde; de energie-integratie en startadviezen behouden hun oorspronkelijke tijdvakken. Er worden geen extra weerverzoeken gedaan en er is geen omzetting naar instantane weerwaarden.

De verticale rasterlijnen volgen echte klokkwartieren. Binnen de zonuren liggen de tijdlabels op vaste klokgrenzen; zonsopkomst en zonsondergang blijven als exacte randen staan. De lijn loopt door tot die randen, maar de daarvoor berekende randwaarden krijgen geen bolletje. Zo lijken randwaarden niet op echte bronpunten. Een tooltip op een geel punt noemt het bijbehorende tijdvak; bij uurterugval blijft ook de oorspronkelijke bronresolutie zichtbaar. De cursor toont seconden en de muisbediening dekt de punttooltips niet meer af. De rechte lijn tussen twee punten is een weergaveschatting, geen extra bronmeting.

Een blauwe punt gebruikt de laatste echte meettijd van de omvormers in dat totaal. Bij ongelijke meettijden toont de tooltip het bereik. Bijvoorbeeld: ophalen om 14:15 kan een meting van 14:12:46 opleveren; die hoort op 14:12:46 te blijven staan. De eigen logger en de Growatt-cloud bepalen de aangeleverde meettijd. De API geeft per totaalpunt `measured_from`, `measured_to`, `measurement_span_seconds` en `received_at` terug. `time` blijft de laatste echte meettijd. Meetpunten worden niet afgerond, verplaatst of verzonnen om ze op een kwartier te laten lijken.

De voorspelslots bevatten nu `time` (gelijk aan `end`), `time_basis: "preceding_interval_mean"`, `sample_start` en `sample_end`. De laatste twee behouden de oorspronkelijke bronperiode, ook als uurdata in effectieve kwartierdelen is verdeeld. `start`/`end` blijven de effectieve tijdvakgrenzen voor het apparaatadvies. Deze weergavecorrectie verandert geen opgeslagen meetklokken en vereist geen databasemigratie.

Het dashboard geeft per apparaat en programma een starttijd op iedere dag van `weather.forecast_days`. De volledige cyclus van dat programma moet binnen de zonuren van die dag passen. Vandaag worden alleen toekomstige starttijden gezocht. Dezelfde apparaatprofielen, basislast, reserve en minimale zonnefractie gelden als voor het bestaande ESP32-advies. Ontbrekende of verouderde gegevens worden afzonderlijk weergegeven. Het losse `/intern/api/v1/appliances/<id>/advice`-endpoint blijft `advice.search_hours` gebruiken; `/intern/api/v1/appliances/daily` gebruikt alle ingestelde voorspeldagen.

Als geen startmoment de hele cyclus voor 100% uit zonne-energie kan dekken, toont het dashboard per programma en per dag **Meeste zon**, met het beste starttijdstip en de verwachte zonnedekking. Bijvoorbeeld: **14:10 — Meeste zon · 65%**. Er is dan aanvulling uit het net nodig. De keuze maximaliseert de zonne-energie die het programma gedurende zijn volledige cyclus gebruikt; het tijdstip met de hoogste zonnepaneelopbrengst hoeft daarvoor niet het beste startmoment te zijn. Basislast, reserve en lopende apparaten tellen mee. Bij gelijke uitkomsten wordt het vroegste moment gekozen. De bestaande stapgrootte `advice.start_step_minutes` blijft gelden.

Een starttijd die aan het ingestelde `min_solar_share` voldoet, blijft staan. Is die grens bijvoorbeeld 70% en bestaat er geen optie van 100%, dan kan daarnaast **Meeste zon: 14:10 · 85%** verschijnen. Als beide tijden gelijk zijn, wordt het tijdstip eenmaal getoond. Bij nul bruikbare zonne-energie, ontbrekende of verouderde gegevens verschijnt geen alternatief. Een draaiend apparaat blijft vandaag **Bezig** tonen. Voor deze toevoeging zijn geen configuratiewijzigingen of extra bronverzoeken nodig.

Op `/intern/homewizard` staan host, lokale API-versie, laatste meetwaarden, import-/exporttellers, responstijd en fout per meter. Onder **Apparaten** verschijnen ook alle apparaten met een ingestelde Energy Socket, met hun profielnaam, eigen IP-adres, actuele aan-/uitstatus en vermogen. De verzoekentijdlijn kan op meter of afzonderlijke socket en op resultaat worden gefilterd. Sockets blijven apart van de netto netmeting. **Nu ophalen** leest de ingestelde lokale netmeters; sockets volgen hun bestaande achtergrondinterval. Autorisatieheaders en tokens worden niet gelogd.

### Database bekijken

Open **Database** in de navigatie of ga naar `/intern/database`. Via **Tabel kiezen** opent een doorzoekbare popup met alle toepassingstabellen in de huidige database. De volledige inhoud is per pagina beschikbaar, inclusief alle kolommen, lange tekstvelden en binaire velden als `0x…`-hextekst. `NULL` en een lege tekstwaarde (`""`) worden afzonderlijk getoond. Grote gehele getallen worden zonder precisieverlies weergegeven.

Klik op een kolomnaam voor oplopende of aflopende sortering. De invoervelden onder iedere kolom zoeken letterlijk naar een deel van de waarde; meerdere filters gelden samen. `%` en `_` zijn gewone zoektekens. Met **Records per pagina** kies je 10, 25, 50, 100, 250 of 500 records. Gebruik de paginaknoppen of voer een paginanummer in om alle resultaten te bereiken. **Filters wissen** herstelt de ongefilterde inhoud en **Vernieuwen** haalt de actuele pagina op. De pagina leest uitsluitend; er zijn geen schrijf- of verwijderacties.

De bijbehorende leesendpoints zijn `GET /intern/api/v1/database/tables` en `GET /intern/api/v1/database/rows?table=forecast&page=1&page_size=50`. Optionele parameters zijn `sort` (kolomnaam), `direction=asc|desc` en `filters` (een JSON-lijst met objecten zoals `{"column":"source","value":"open-meteo"}`). Tabellen en kolommen worden tegen het actuele schema gecontroleerd. Filterwaarden worden als parameters doorgegeven. Hiervoor zijn geen configuratiewijziging, extra bronverzoeken of databasemigratie nodig.

### Apparaten, programma's en minimale zonnedekking

Ieder bestand in `config/appliances/` beschrijft één fysiek apparaat. Zet de eigen minimale zonnedekking in dat bestand met `min_solar_share`, als fractie van 0 tot en met 1. `0.95` betekent minimaal 95% van de energie van de volledige programmacyclus uit beschikbare zonne-energie. Deze grens geldt voor alle programma's van dat apparaat. Zonder dit veld, of met `null`, gebruikt ZonAPI `advice.min_solar_share` uit `config/settings.json`. Een expliciete `0` is geldig en wordt niet vervangen door de algemene instelling. De apparaatkaart toont het gebruikte minimumpercentage.

Voor meerdere programma's gebruik je een niet-lege `programs`-lijst. Elk programma heeft een unieke `name` en een eigen niet-lege `steps`-lijst. Iedere stap bevat `duration_minutes` en `power_w`; de programmaduur wordt uit de stappen berekend. Een programma-`id` is optioneel: zonder `id` wordt het uit de naam afgeleid. Met een expliciete `id` blijven verwijzingen gelijk als je de naam verandert.

Bijvoorbeeld in `config/appliances/vaatwasser.json`:

```json
{
  "id": "vaatwasser",
  "name": "Vaatwasser",
  "estimated_profile": true,
  "min_solar_share": 0.95,
  "homewizard": { "host": "" },
  "programs": [
    {
      "id": "eco",
      "name": "Eco",
      "steps": [
        { "duration_minutes": 60, "power_w": 500 },
        { "duration_minutes": 30, "power_w": 100 }
      ]
    },
    {
      "id": "snel",
      "name": "Snel",
      "steps": [
        { "duration_minutes": 15, "power_w": 1500 },
        { "duration_minutes": 15, "power_w": 100 }
      ]
    }
  ]
}
```

Dit voorbeeld staat ook in `examples/vaatwasser-programmas.json`. De tijden en vermogens zijn **voorbeeldschattingen**: gebruik je eigen verbruiksfasen en behoud het bestaande socket-IP en de eigen herkenningsinstellingen. De update past de eigen apparaatbestanden niet aan. Zonder `programs` blijft de bestaande `steps`-lijst geldig als één programma **Standaard**. Als beide velden aanwezig zijn, gebruikt het advies de programma's uit `programs`.

Het dashboard toont voor ieder programma de naam, duur en adviezen voor vandaag, morgen en overmorgen. Elk programma krijgt een eigen vroegste start die aan de apparaatgrens voldoet, plus waar van toepassing een eigen **Meeste zon**-alternatief. Zo kan Eco op een ander moment geschikt zijn dan Snel. Ook de JSON-adviezen bevatten `program_id` en `program_name`. Het algemene apparaatadvies kiest het vroegste geschikte programma; `best_program_id` en `best_program_name` noemen het programma met het hoogste zonnedekkingspercentage. Beide keuzes kunnen verschillen. Alle afzonderlijke uitkomsten staan in `programs`.

`GET /intern/api/v1/appliances/vaatwasser/advice?program=eco` beperkt het losse advies tot dat programma. De parameter accepteert de exacte programma-id of naam; een onbekend programma geeft HTTP 404. Zonder parameter bevat het antwoord alle programma's. De openbare dashboardsnapshot toont programmanamen, duur en adviezen, zonder de ruwe stappen of apparaat-IP's.

Wijzigingen aan apparaatbestanden worden bij de volgende API-aanvraag gelezen; het dashboard ververst iedere 30 seconden. Alleen voor een wijziging van de algemene instelling in `settings.json` moet ZonAPI worden herstart.

### Energy Socket per apparaat

Voeg aan ieder gewenst bestand in `config/appliances/` een `homewizard`-object toe, naast `id`, `name` en `steps`. Vul het eigen IP-adres van de Energy Socket in:

```json
"homewizard": {
  "host": "192.168.2.123",
  "start_threshold_w": 10,
  "stop_threshold_w": 5,
  "start_delay_seconds": 30,
  "stop_delay_seconds": 300
}
```

Alleen `host` is nodig; de overige velden hierboven zijn de standaardwaarden. Een ontbrekend `homewizard`-object of lege `host` schakelt de uitlezing voor dat apparaat uit. Bestaande apparaatprofielen blijven geldig. Het bestand wordt bij iedere socketronde opnieuw gelezen; IP-adressen en herkenningsgrenzen kun je daardoor tijdens bedrijf aanpassen. De update-ZIP overschrijft je bestaande apparaatbestanden niet. De volledige versie bevat een lege host per voorbeeldapparaat.

Zet per socket de **Lokale API** aan in de HomeWizard-app via **Instellingen → Meters → de socket → Lokale API**. ZonAPI leest via het LAN `GET http://<host>/api/v1/data` en gebruikt `active_power_w`. Dat is de [officieel gedocumenteerde Energy Socket-meet-API](https://api-documentation.homewizard.com/docs/v1/measurement/). De huidige Energy Sockets gebruiken hiervoor v1; je hoeft geen token in te stellen. De aanvraag schakelt de socket of het apparaat niet aan of uit.

ZonAPI leest de sockets iedere `homewizard.poll_seconds` uit `settings.json`, onafhankelijk van de P1- en kWh-meter. Volgens de standaardherkenning moet het vermogen minstens **30 seconden aaneengesloten 10 W of hoger** zijn om een start vast te stellen. De kaart toont vervolgens **Actief**, het actuele vermogen en de tijd vanaf de eerste bevestigde verbruikstoename. De starttijd is het moment waarop ZonAPI het verhoogde verbruik voor het eerst waarnam; bij een al draaiend apparaat kan de echte start eerder zijn geweest. Vandaag staat in de startplanning dan **Bezig**. De berekening van de zonnedekking en de planning voor volgende dagen blijven hetzelfde.

Pas na **5 minuten aaneengesloten 5 W of lager** wordt het apparaat weer **Niet actief**. Dat voorkomt dat korte pauzes in een programma als stoppen worden gezien. Stel de grenzen af op het stand-byverbruik en de langste gebruikelijke programmapauze van je eigen apparaat; verbruik alleen kan niet ieder programma of iedere handmatige pauze onderscheiden. Verbruik tussen de beide grenzen verandert de lopende toestand niet. `stop_threshold_w` moet lager zijn dan `start_threshold_w`; beide wachttijden zijn instelbaar van 0 tot 3600 seconden.

Bij een mislukte of te oude socketmeting toont het dashboard **Socket niet bereikbaar**, met de fout als toelichting. Het presenteert dan geen actuele aan/uitstatus. De geldigheid is minimaal 2 minuten, of drie pollintervallen als dat langer is. Na een langdurige meetonderbreking wordt de start opnieuw vastgesteld. Een korte serverherstart behoudt een recent herkende actieve cyclus; IP- of grenswijzigingen beginnen met nieuwe herkenning. Een socket meldt het actuele vermogen, maar niet welk ingesteld programma werkelijk draait.

`GET /intern/api/v1/appliances` bevat per profiel `activity` met `configured`, `state`, `running`, `power_w`, `measured_at`, `started_at`, `stopped_at` en `error`. Apparaatverbruik komt in een eigen statustabel en wordt nooit als extra netmeter bij P1/kWh opgeteld. De laatste status overschrijft één rij per apparaat. Daarnaast worden de begrensde cyclusmetingen hieronder bewaard, ook als debuglogging uitstaat. Met HomeWizard-logging aan verschijnen de aanvragen als `socket:<apparaat-id>` in de bestaande begrensde verzoekentijdlijn. Logs wissen laat de actuele apparaatstatus en cyclusgrafieken staan.

### Apparaatgrafieken per cyclus

Onder **Apparaatverbruik** staat per apparaat een grafiek met het vermogen in watt en tijd sinds de start. De blauwgroene lijn toont het gemeten totale verbruik van de huidige/laatste cyclus; de gele lijn gebruikt de vorige volledig gemeten cyclus als verwachting. Vanaf **2026-10-20-Cyclusbronnen1** toont de **groene lijn het verbruik uit zon** en de **rode lijn het verbruik uit het net**, voor de huidige/laatste cyclus. Alle lijnen beginnen op **0 minuten**, zodat de verbruiksfasen gelijk op de tijdas staan, ook wanneer de programma's op verschillende dagen gestart zijn. De vorige lijn blijft in beeld voor de volledige eerder gemeten programmaduur. Het is een vergelijking met het vorige programma; een ander gekozen programma kan een ander verloop hebben.

De bronverdeling wordt **berekend uit echte vermogensmetingen**, zonder weersverwachting, kalibratiefactor, basislastinstelling of reserve. Een Energy Socket meet het apparaatvermogen, maar meet de herkomst van de stroom niet afzonderlijk. Daarom wordt dezelfde gemeten huisverhouding op ieder apparaat toegepast: **huisverbruik = Growatt-opwek + netto netvermogen**, met afname positief en teruglevering negatief. Het zonnedeel is de gemeten opwek gedeeld door het huisverbruik, begrensd op 0–100%; de rest komt uit het net. Bij teruglevering is het apparaat volledig door zon gedekt. Bijvoorbeeld: 600 W opwek en 600 W netafname geven 50% zonnedekking; een apparaat van 1000 W krijgt dan 500 W groen en 500 W rood. Gelijktijdige apparaten krijgen elk hun evenredige aandeel, zodat dezelfde zonne-energie niet opnieuw volledig aan ieder apparaat wordt toegekend. De toelichting onder de grafiek vermeldt deze berekende verdeling.

De berekening koppelt elk socketpunt aan de laatst beschikbare complete Growatt-meetronde en één geldige netmeter **op of vóór die meettijd**. De bestaande bronkeuze, bekende omvormers en versheidsmarges blijven gelden, inclusief minimaal twintig minuten voor vertraagd aangeleverde cloudmetingen. Netmetingen zijn maximaal twee minuten oud; de ingestelde voorkeur voor P1 of kWh geldt zonder deze twee metingen bij elkaar op te tellen. Ontbrekende of te oude bronnen, een onvolledige eerste omvormerronde of een berekend huisverbruik kleiner dan het apparaatverbruik geven **onbekend**, met gaten in beide nieuwe lijnen. Een echte gemeten nul tijdens een programmapauze is voor beide bronnen nul. Groen plus rood is bij een geldige verdeling altijd gelijk aan het totale apparaatvermogen. Bestaande cycli krijgen de lijnen ook wanneer hun historische bronmetingen nog aanwezig zijn. Er zijn geen extra API-aanvragen, nieuwe instellingen of wijzigingen aan de database nodig.

De verticale lijn toont **Verstreken uu:mm:ss** en telt iedere seconde verder. Hiervoor zijn geen extra socketaanvragen nodig; de vermogensmetingen volgen het bestaande HomeWizard-interval en het dashboard haalt nieuwe meetpunten iedere 30 seconden uit de eigen API. Beweeg de muis over de grafiek voor verstreken tijd, het huidige en vorige vermogen en de waarden **Uit zon** en **Uit net**. Na focus werken Home, End en de pijlen; de pijlen verplaatsen hier één minuut. De datum/tijd van de echte start staat boven de grafiek, de grafiek zelf gebruikt uitsluitend verstreken tijd en blijft daardoor correct rond middernacht en zomer-/wintertijd.

De opname begint bij de eerste meting van de bevestigde start. De metingen tijdens de startwachttijd worden daarvoor tijdelijk bewaard en bij een bevestigde start meegenomen; een korte losse piek verdwijnt weer. Korte pauzes binnen een programma blijven zichtbaar. Na bevestiging van het einde worden de extra metingen van de stopwachttijd afgeknipt: de eindtijd ligt bij de eerste lage meting van die laatste, aaneengesloten stopperiode. Er wordt geen hele dag met stand-byverbruik getekend. Als het apparaat klaar is, blijft de laatste cyclus staan om te bekijken, met de voorafgaande volledige cyclus ernaast als die beschikbaar is.

Een volledige referentie is pas beschikbaar nadat ZonAPI een cyclus vanaf een recente waargenomen inactieve toestand tot het bevestigde einde heeft kunnen opnemen. Bij installatie terwijl het apparaat al draait, een ontbrekend begin, een langdurige meetonderbreking of gewijzigde socketinstellingen wordt een gedeeltelijke curve getoond; die wordt niet als verwachting gebruikt. Bij ontbrekende actuele metingen bevriest de verticale lijn op de laatste meting en staat er **Gemeten tot**. Meetgaten langer dan de maximale meetpauze worden niet doorgetrokken. Een korte herstart behoudt de lopende cyclus en al vastgelegde meetpunten. De eerste bruikbare verwachting ontstaat na een volledig opgenomen cyclus.

De database bewaart per apparaat maximaal **de lopende cyclus plus de twee laatst afgesloten cycli**. Onderbroken cycli tellen mee in die twee; alleen volledige, normaal afgesloten cycli kunnen referentie zijn. Oudere cycli en hun meetpunten worden automatisch verwijderd. Een startkandidaat die niet bevestigd wordt, verdwijnt eveneens. Iedere cyclus is begrensd op 24 uur en 20.000 meetpunten. Zo groeit deze historie niet onbeperkt. De cyclusopslag en socketstatus worden samen in één transactie bijgewerkt; logging is hiervan onafhankelijk.

`GET /intern/api/v1/appliances/cycles` geeft per apparaat `current`, `previous`, `live`, `elapsed_seconds` en `activity`. Meetpunten bevatten `elapsed_seconds`, `power_w`, `solar_power_w` en `grid_power_w`; onbekende bronvermogens zijn `null`. De cyclusmetadata bevat de echte start/eindtijd, duur, maximale meetpauze, `complete` en `energy_split_method: "proportional_household"`. De openbare dashboardsnapshot geeft alleen deze zichtbare waarden door, zonder bronadressen of serienummers. `previous` is `null` zolang er geen bruikbare voorafgaande cyclus is. De JSON-programmaprofielen blijven de bron voor het te starten apparaat. De gemeten cyclusgrafiek blijft per fysiek apparaat; eerdere cycli worden niet automatisch aan een programmanaam gekoppeld. Voor de resterende vraag van een actief apparaat geldt de aanpak hieronder.

### Startadvies bij actieve apparaten

Wanneer een Energy Socket een start herkent, houdt ZonAPI in de adviezen voor andere apparaten automatisch rekening met het **resterende verbruik**. De berekening is per tijdstip:

**Beschikbaar voor het nieuwe apparaat = voorspelde opwek − basislast − reserve − het totale verwachte verbruik van actieve apparaten**, met minimaal nul beschikbaar vermogen.

Voor ieder actief apparaat worden de resterende fasen bepaald vanaf de herkende starttijd. Bij één ingesteld programma gebruikt ZonAPI bij voorkeur de vorige volledig gemeten cyclus, met dezelfde schuine lijnen als in de cyclusgrafiek. Zonder geschikte cyclus gebruikt ZonAPI de fasen in het JSON-profiel. Bij meerdere ingestelde programma's is het werkelijk draaiende programma onbekend. ZonAPI rekent dan op ieder tijdstip met het hoogste vermogen van de mogelijke programma's, tot het einde van het langste programma (`program_envelope`). Alternatieve programma's worden nooit bij elkaar opgeteld en de socket wordt maar eenmaal uitgelezen. Deze voorzichtige schatting kan een advies voor een ander apparaat later laten beginnen. De eerstvolgende pollperiode wordt gebaseerd op het actuele socketvermogen. Daarna volgt het resterende verwachte verloop. Een fase van 2000 W die al voorbij is, wordt niet opnieuw voor de hele programmaduur afgetrokken. Korte verwarmingspieken, faseovergangen en eindtijden tellen op hun eigen tijdstip mee, ook binnen één kwartierprognose.

Meerdere actieve apparaten worden bij elkaar opgeteld. Een zware fase kan de starttijd van een ander apparaat naar achteren schuiven; tijdens een lichte fase kan er wel genoeg ruimte zijn. Zodra een stop bevestigd is, vervalt de reservering bij de volgende adviesaanvraag. Als een cyclus vandaag eindigt, wordt die belasting niet naar morgen of overmorgen doorgetrokken. Een actief apparaat krijgt zelf geen tweede overlappende start voorgesteld. Ook een nog te bevestigen startkandidaat telt al mee zolang de recente socketmetingen verhoogd verbruik tonen.

Duurt het apparaat langer dan zijn vorige cyclus of JSON-profiel, dan blijft het meetellen. ZonAPI gebruikt dan het huidige vermogen en schat vanaf nu nog eenmaal de JSON-programmaduur, minimaal 5 minuten en maximaal 24 uur. De bron is dan `current_power` en de duur blijft een schatting totdat de socket een stop bevestigt. Bij meetuitval blijft een laatst bekende actieve toestand meetellen op basis van het verwachte resterende profiel. Is ook die duur verstreken, dan wordt zonder actuele meting voorzichtig het hoogste JSON-fasevermogen of het hogere laatst gemeten vermogen gereserveerd. Het dashboard vermeldt daarbij **laatste status actief**. Een onbereikbaar apparaat wordt dus niet onmiddellijk als uit beschouwd.

Op de apparaatkaart staat **Rekening gehouden met: ...** voor andere actieve apparaten. Bij de tekst staat als toelichting de geschatte resterende duur. De bestaande minimale zonnedekking over de volledige cyclus, basislast en reserve blijven gelden. De adviezen worden opnieuw berekend met de opgeslagen socketmetingen; hiervoor zijn geen extra HomeWizard-, Growatt- of weerverzoeken nodig.

`GET /intern/api/v1/appliances/daily` bevat bovenaan `active_appliances`; het losse `/intern/api/v1/appliances/<id>/advice`-endpoint bevat de meegerekende andere apparaten bij dezelfde naam. Per actief apparaat staan onder meer `source` (`previous_cycle`, `profile`, `program_envelope` of `current_power`), `fresh`, `expected_end`, `remaining_minutes` en `overrun`. Het eigen advies kan ook `already_active` en `busy_until` bevatten. Voor dashboard en ESP32 geldt dezelfde berekening. De bestaande socket-IP's en JSON-profielen worden gebruikt.

Een startadvies voor een nog niet gestart apparaat reserveert zelf geen vermogen voor de andere adviezen. Pas bij herkend verbruik telt het apparaat als actieve belasting mee. Het model gebruikt de basislast als achtergrondverbruik; kies een vaste basislast exclusief de apparaten die afzonderlijk worden meegerekend.

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

Vul de vier serienummers in `config/panels.json` in als je die kent. Zonder opgegeven serienummers herkent ZonAPI de installatie en omvormers automatisch. Bij meerdere installaties toont `/intern/growatt` de namen en IDs; kies er dan één met `cloud.plant_id`. Laat voor automatische herkenning alle omvormerserienummers leeg. Er wordt geen willekeurige installatie gekozen. Voor deze MIC-omvormers is het gebruikelijke type `min`; `inv` is beschikbaar voor de klassieke inverterfamilie.

ZonAPI start de Growatt-opvraagronde op vaste Nederlandse vijfminutenmomenten: **ieder uur om :00, :05, :10, :15, …, :55**, ook zonder dashboard- of ESP32-verzoeken. De duur van een antwoord verschuift de volgende ronde niet. Na starten of herstarten wordt op het volgende vijfminutenmoment gewacht; gemiste rondes worden niet ingehaald en lopende rondes overlappen niet. Een bestaand `poll_seconds: 900` hoeft niet aangepast te worden: de effectieve waarde is voortaan altijd 300 seconden. Het oude veld blijft geldig voor bestaande configuraties (300–86400 seconden). Er zijn geen nieuwe instellingen nodig om deze planning te gebruiken.

Op `/intern/growatt` staan **Gepland opvragen** en **Startvertraging ronde** in milliseconden. Per omvormer staan de werkelijke HTTP-opvraagtijd, de meettijd uit het antwoord en de ontvangsttijd naast elkaar. In de cloudstatus heten deze velden `last_scheduled`, `schedule_delay_ms` en `last_measurements` (`requested_at`, `measured_at`, `received_at`, `age_at_receipt_seconds`). Dit maakt timervertraging en oudere Growatt-data afzonderlijk controleerbaar, ook als debuglogging uitstaat. De omvormers worden achtereenvolgens gelezen met de ingestelde pauze; het tweede tot en met vierde verzoek begint daardoor enkele seconden na het vijfminutenmoment. Het volgende geplande moment schuift niet op.

Bij fouten wordt minimaal vijf minuten tussen pogingen gehouden; herhaalde fouten verhogen de wachttijd naar 10, 20, 40 en maximaal 60 minuten. HTTP `Retry-After` kan een langere wachttijd opleggen. De volgende poging valt op het eerste toegestane vijfminutenmoment. Growatt-codes `102` (`FREQUENTLY_ACCESS`) en `501` stoppen de hele opvraagcyclus, ook bij HTTP `200`. De wachttijd blijft bewaard over herstarts, ook bij de overgang van de oude kwartierplanning. **Nu ophalen** behoudt zowel de klokplanning als de foutwachttijd. Met `daylight_only: true` worden buiten de lokale zonuren momenten overgeslagen; na zonsopkomst wordt op het eerste vijfminutenmoment opgehaald. Bij `auto` wordt een ronde overgeslagen als alle lokale ShineLink-metingen actueel zijn.

Voor cloudmetingen blijft een versheidsgrens van `max(growatt.fresh_minutes, 20)` minuten gelden, met marge voor vertraagde aanlevering. ShineLink behoudt de ingestelde grens. Oudere en toekomstige meetwaarden blijven uitgesloten; opnieuw ontvangen oude data krijgt geen nieuwe meettijd. De cloudstatus vermeldt de effectieve grens als `fresh_minutes`.

De vijfminutenmomenten leveren de meetpunten rond de kwartierindeling van de weersvoorspelling. Het ingestelde weerinterval blijft gelden; er worden hiervoor geen extra weerverzoeken gemaakt. De meettijd uit Growatt blijft leidend. Echte meetklokken in de opslag en grafiek worden niet afgerond. `request_pause_ms` bepaalt de pauze tussen opeenvolgende webverzoeken en is standaard 1100 ms, instelbaar van 1000 tot 10000 ms. De adapter leest metingen per omvormer; een geslaagde cyclus bestaat bij vier omvormers uit vier opeenvolgende meetverzoeken. De ronde begint op het vijfminutenmoment, de afzonderlijke antwoorden volgen daarna.

Cloudmetingen bewaren `pac` in watt en `eacToday`/`eacTotal` in kWh. De meettijd komt eerst uit `time`, daarna uit `last_update_time`; `calendar` wordt alleen gebruikt als die twee velden ontbreken of leeg zijn. Een aanwezige ongeldige of dubbelzinnige meetklok wordt afgewezen. Zonder tijdzone in `time` wordt `cloud.timezone` gebruikt; standaard `Europe/Amsterdam`, inclusief zomer- en wintertijd. Een expliciete `Z` of UTC-offset blijft leidend. SQLite en de HTTP-API bewaren UTC; het dashboard zet die één keer om naar de Nederlandse tijd. Zo wordt `2026-10-16 16:02:46` opgeslagen als `2026-10-16T14:02:46.000Z` en getoond als `16:02:46`. Een herhaald oud antwoord maakt geen nieuw actueel meetpunt. De opbrengstgrafiek en basislastberekening tellen iedere omvormer eenmaal. Beide meetbronnen blijven afzonderlijk bewaard; de kalibratiefactor wordt niet op gemeten opbrengst toegepast.

Bij starten herstelt ZonAPI bestaande cloudmetingen die met de vroegere `calendar`-voorkeur zijn opgeslagen, voor zover het oorspronkelijke webantwoord nog in het logboek staat. Herstel gebeurt vóór de automatische logopschoning en vereist een overeenkomst van serienummer, oude meettijd, ontvangstvenster, vermogen en energietellers. Alle vastgestelde verschuivingen worden in één transactie verwerkt; bij gelijke nieuwe meettijd behoudt de nieuwste ontvangen meting voorrang. ShineLink-metingen, ruwe webantwoorden en metingen zonder bijpassend bronantwoord blijven behouden. Er worden geen vaste uren bij de opgeslagen geschiedenis opgeteld.

Op `/intern/growatt` staan webbronstatus, de vijfminutenplanning, vorige/volgende poging, de laatste fout en de **Kwartiercorrectie**. Die laatste toont hoeveel van de drie meetmomenten zijn gebruikt of welke nog ontbreken. De tabel **Omvormers** leest iedere 15 seconden rechtstreeks `/intern/api/v1/production/current` en toont de ingestelde lokale of webbron, met vermogen, energietellers, meettijd en ontvangsttijd per omvormer. De tabel wordt onafhankelijk van de bronstatus en berichtenlijst bijgewerkt. De knop **Vernieuwen** leest dezelfde actuele databasewaarden; een Growatt-webverzoek volgt de vijfminutenplanning. Kies **Toon → Web-API** voor de verzoeken of **Fouten** voor alle fouten. **Bekijk** toont HTTP-metadata en het geschoonde JSON-antwoord. De bestaande Growatt-logschakelaar en verwijderknop gelden ook voor deze verzoeken. Historische cloud- en ShineLink-metingen blijven behouden.

Bij systemd kun je optioneel `/etc/zonapi/growatt.env` met `GROWATT_API_TOKEN=...` gebruiken. Het meegeleverde servicesjabloon leest dit bestand. Voor een reeds geïnstalleerde service voeg je met `sudo systemctl edit zonapi` onder `[Service]` de regel `EnvironmentFile=-/etc/zonapi/growatt.env` toe. Herstart Node na het wijzigen van broninstellingen of token.

### Weerdiagnose

Open `/intern/weather` voor de ingestelde locatie, het werkelijk opgebouwde Open-Meteo-adres, zontijden, resolutie, aanvraaggeschiedenis, HTTP-status, fouttekst, opgeslagen instraling en **Bewolking vandaag**. Die tabel toont per oorspronkelijk uurpunt het bewolkingspercentage, dezelfde classificatie als het grafiekicoon, de ruwe weercode, het gekozen model, de afzonderlijke controle **Strikt helder** en de ophaaltijd met eventuele verouderingsmelding. Strikt helder vereist nog steeds exact 0% bewolking én weercode 0; de interne JSON-rij bevat daarvoor `correction_condition`. De gegevens staan ook in `conditions` van `/intern/api/v1/weather`, met `time_basis: "instant"` en `resolution_minutes: 60`. `Nu ophalen` slaat het normale tijdsinterval over voor één poging. Er is geen dagelijkse aanvraaglimiet meer; pauzeren en bescherming tegen overlappende aanvragen blijven gelden. Een eerdere HTTP 400 kan als oude fout zichtbaar blijven in de geschiedenis; een nieuw verzoek slaat de volledige foutreden van Open-Meteo op.

De weerscheduler haalt gedurende de hele dag op, ook 's avonds en 's nachts. Vanaf **2026-10-21-PollMinuten1** bepaalt **`weather.poll_minutes`** het vaste aantal minuten tussen normale pogingen. De voorbeeldinstelling is `120`, gelijk aan de eerdere standaardfrequentie van ongeveer iedere twee uur. Met `15` wordt iedere vijftien minuten opgehaald; `0` pauzeert de bron, inclusief de knop Nu ophalen. Hele waarden van 0 tot en met 1440 zijn toegestaan. Het interval wordt gerekend vanaf de laatste poging en blijft even lang bij middernacht en op dagen van 23 of 25 uur. Bij fouten geldt voor automatische pogingen minimaal `retry_minutes`, als dat langer is dan het ingestelde interval. De laatste poging en foutwachttijd blijven na een herstart behouden. Wissen of uitschakelen van logs reset deze planning niet. De achtergrondcontrole loopt iedere minuut. Zonsopkomst en zonsondergang bepalen alleen de grafiekgrenzen en apparaatadviezen.

Vervang in je eigen `settings.json`, binnen `weather`, de oude regel met `max_requests_per_local_day` door bijvoorbeeld **`"poll_minutes": 15`** en herstart ZonAPI. De oude instelling is uit de voorbeeldconfiguratie, validatie, planning en weergave verwijderd en wordt niet meer gebruikt. Ontbreekt de nieuwe instelling bij een bestaande installatie, dan geldt standaard 120 minuten; er wordt geen oud dagmaximum naar een interval omgerekend. Het dashboard en de Weer-pagina tonen het minuteninterval. De teller Verzoeken vandaag is uitsluitend informatief en stopt de aanvragen niet. Bestaande tellers en aanvraaghistorie blijven bewaard; er is geen databasemigratie nodig.

### Benodigde weergegevens

Vanaf versie **2026-10-20-Weeropvraag1** vraagt ZonAPI geen twee eerdere kalenderdagen of vast etmaal aan eerdere kwartierdata meer op. `past_days=2`, `past_minutely_15=96` en het afzonderlijke `forecast_minutely_15=192` zijn verwijderd. Alle reeksen volgen nu de kalenderperiode van `forecast_days`: standaard **vandaag, morgen en overmorgen**, vanaf vandaag 00:00 Nederlandse tijd. Ook het verstreken deel van vandaag blijft daardoor beschikbaar. Een bewust hoger ingestelde `weather.forecast_days` blijft gelden voor de bijbehorende dagadviezen. Er worden geen vaste datums in de URL opgenomen; bij een nieuwe dag schuift het verzoek automatisch mee.

De aangevraagde velden blijven beperkt tot de gebruikte **GHI, DNI, DHI, bewolkingspercentage, weercode, zonsopkomst en zonsondergang**. Beide modellen blijven nodig voor native ICON-D2-kwartierinstraling, de bijpassende bewolkingscontrole en Best Match als terugval buiten de beschikbare kwartierdekking. Alles wordt in één HTTP-verzoek opgehaald. De werkelijk verzonden URL en **Actueel verzoek** op `/intern/weather` gebruiken dezelfde opbouw; **Weerverzoeken → Bekijk** bewaart de URL van de geselecteerde uitgevoerde poging.

Bestaande correcties, historische instraling en opgeslagen bewolkingspunten blijven lokaal bewaard volgens de bestaande bewaartermijnen. Wachtende correcties gebruiken die al aanwezige uurpunten, zonder eerdere kalenderdagen opnieuw op te vragen. Een ontbrekend historisch uurpunt blijft onbekend en kan geen nieuwe correctie goedkeuren. De heldere-hemelcontrole en de onafhankelijke kwartiercorrecties veranderen niet. Er zijn geen nieuwe instellingen of databasewijzigingen nodig.

### Kwartierprognose

ZonAPI vraagt standaard GHI, DNI en DHI per 15 minuten op via Open-Meteo. Eén gecombineerd verzoek met `models=best_match,icon_d2` haalt de native ICON-D2-kwartierwaarden en de Best-Match-uurwaarden op, voor dezelfde kalenderperiode vanaf vandaag. Binnen de beschikbare ICON-D2-horizon van ongeveer twee dagen worden de kwartieren gebruikt; ontbrekende kwartieren en verder gelegen dagen gebruiken uurwaarden. Dit volgt de [Open-Meteo-parameterdefinities](https://open-meteo.com/en/docs) en de [ICON-D2-specificatie](https://open-meteo.com/en/docs/dwd-api).

De bronwaarden zijn gemiddelden over het voorafgaande kwartier of uur. De API zet ze om naar UTC-intervallen en rekent daarna zelf de paneelopbrengst uit. Opslag, grafieken, historie en apparaatadviezen gebruiken dezelfde selectie: nieuwere ophaaltijd gaat voor, bij gelijke ophaaltijd gaat de fijnste resolutie voor. Uur- en kwartierwaarden worden niet dubbel geteld. De oorspronkelijke intervallen en modelnamen blijven opgeslagen, ook als slechts een deel van een uur als terugval wordt gebruikt.

Het ingestelde minuteninterval en de kalibratiefactor blijven gelden; de kwartierresolutie verhoogt de ophaalfrequentie niet. Nieuwe kwartierdata komt bij de eerstvolgende geplande ophaalpoging beschikbaar, of via **Nu ophalen** op `/intern/weather`. Daar staat onder **Resolutie vandaag** bijvoorbeeld `15 min` of `15 / 60 min`.

Optioneel kun je in de bestaande `weather`-sectie `"resolution_minutes": 15` opnemen. Met `60` wordt uitsluitend de oorspronkelijke uurvoorspelling aangevraagd, met automatische modelkeuze. Herstart Node na wijzigen. De voorspelling- en instralingendpoints geven `resolution_minutes` (fijnste bronresolutie), `resolutions_minutes` en `mixed_resolution` terug. Ieder slot bevat ook `model`, de effectieve `resolution_minutes` en de oorspronkelijke `source_resolution_minutes`.

### Growatt-teller op nul

Open `/intern/growatt` en lees `TCP`, `Database` en `Ontvangen pakketten`; dezelfde velden staan in `GET /intern/api/v1/growatt` (`listener`, `database_path`, `summary.frames_total`). De teller leest de actieve SQLite-database; hij wordt ook nul na de knop **Berichten en logs verwijderen**. Historische vermogensmetingen blijven dan wel bestaan. De TCP-status is `true` als poort 5279 werkelijk luistert. Bij `false` geeft `listener.last_error` de foutcode, bijvoorbeeld `EADDRINUSE` of `EADDRNOTAVAIL`. Als hij luistert maar er geen nieuwe berichten zijn, controleer in `GET /intern/api/v1/growatt/timeline?view=events&limit=20` of er TCP-verbindingen worden geopend. Op de server:

```sh
curl -s http://127.0.0.1:3002/intern/api/v1/growatt
sudo ss -ltnp '( sport = :5279 )'
sudo journalctl -u zonapi -n 50 --no-pager
```

Vergelijk `database_path` met het databasebestand van de bestaande installatie. Als een nieuwe installatiemap is gebruikt, start de dienst dan weer vanuit de oorspronkelijke map met zijn bestaande `data/`-map.

### Instellingen

| Bestand/veld | Vul in / werking |
| --- | --- |
| `settings.json > location` | Breedte- en lengtegraad van je locatie. Er wordt vóór dit is ingevuld geen extern weerverzoek gedaan. |
| `settings.json > pv.calibration_factor` | Optioneel; standaard `1.0`. Vermenigvuldigt de berekende paneelopbrengst vóór begrenzing per omvormer. Een getal >0 en <=10; bijvoorbeeld `1.78` voor 78% meer opbrengst. |
| `debug.json > logging` | `growatt`, `weather` en `homewizard`: booleans, standaard `false`. `max_entries_per_source`: standaard 5000, instelbaar 100–100000. Bestandswijzigingen gelden direct; dashboardknoppen schrijven hetzelfde bestand. |
| `settings.json > http` | LAN-IP en HTTP-poort voor ESP32's/dashboard. Begint uit voorzorg op `127.0.0.1`. |
| `settings.json > growatt` | LAN-IP/poort voor ShineLanBox; standaard 5279, verwacht vier omvormers. `idle_timeout_minutes` is standaard 30 (instelbaar 1–120). `time_sync_on_announcement` is standaard `true`, ook in bestaande configuraties zonder dit veld. `time_sync_retry_minutes` is standaard 10 (instelbaar 1–120). |
| `settings.json > growatt.production_source` | Optioneel; `shinelink` (standaard), `cloud` of `auto`. |
| `settings.json > growatt.cloud` | Token of `token_env`, HTTPS-serveradres, optionele installatie-ID, interval en daglichtkeuze voor de Growatt-webbron. Zie de web-API-instructies hierboven. |
| `settings.json > weather.poll_minutes` | Vast aantal minuten tussen normale weerpogingen, standaard 120; hele waarden 0–1440. `0` pauzeert de bron. Vanaf de laatste poging, ook 's nachts en na herstart; bij fouten kan `retry_minutes` een langere wachttijd geven. |
| `settings.json > weather.forecast_days` | Standaard 3, instelbaar 3–16; een oude waarde `2` wordt als `3` geladen. Buiten de native kwartierhorizon worden uurwaarden gebruikt. |
| `settings.json > weather.resolution_minutes` | Optioneel; standaard `15`. Vraagt kwartierwaarden met uurterugval op; `60` vraagt uitsluitend uurwaarden op. |
| `settings.json > advice.search_hours` | Standaard 24; advies controleert ook de **volledige** cyclus voorbij dat laatste starttijdstip. |
| `settings.json > advice.min_solar_share` | Standaard `0.7` (70% van de voorspelde apparaatenergie uit eigen opwek). Apparaten mogen een eigen `min_solar_share` hebben; netafname blijft mogelijk. |
| `settings.json > advice.reserve_w` | Vermogensmarge bovenop de geschatte huisbasislast, standaard 300 W. |
| `settings.json > advice.baseload_w` | `null` leert een voorzichtige basislast uit minstens 12 uitgelijnde netto- en vier omvormermetingen; of stel zelf een bekende constante in. De P1 is primair, de kWh-meter kan als alternatieve historie dienen. |
| `panels.json > groups` | Eerst 20 panelen op het zuiden (`azimuth_deg: 180`), maar **Wp, helling en omvormertoewijzing moeten worden ingevuld**. Splits een groep in meerdere richtingen door meerdere regels te maken; de aantallen tellen op tot 20. |
| `appliances/*.json` | Elk apparaat heeft `programs` met per programma een unieke `name` en eigen `steps` (`duration_minutes` en `power_w`). Een oude `steps`-lijst blijft geldig als Standaard. Optioneel eigen `reserve_w` en `min_solar_share`; ontbrekende of `null` minimumwaarde gebruikt de algemene grens. Meegeleverde tijden en wattages zijn **schattingen**, te vervangen door eigen metingen. |

Een enkele groep van 20 panelen heeft geen echte `inverter_id` totdat je weet hoe de panelen verdeeld zijn. Maak vervolgens bijvoorbeeld groepen per omvormer met id `mic-1` … `mic-4`, en zet per groep het juiste aantal, `wp_per_panel` en `tilt_deg` in `panels.json`. Er worden geen extra weerserviceverzoeken gedaan als je later een deel naar oost of west verlegt: één GHI/DNI/DHI-reeks wordt lokaal omgerekend naar ieder paneelvlak. Vul de vier echte omvormerserienummers in `inverters[].serial` in wanneer ze bekend zijn; daarna worden onbekende serienummers niet in de actuele totaalsom opgenomen.

### Opbrengst kalibreren

Voeg op hoofdniveau aan je bestaande `config/settings.json` de sectie `"pv": { "calibration_factor": 1.78 }` toe en herstart Node. Laat je overige instellingen staan. Een factor van `1.0` geeft de oorspronkelijke berekening; `1.78` maakt 208 W ongeveer 370 W; `0.9` verlaagt de uitkomst met 10%. Voor een volgende bijstelling vermenigvuldig je de bestaande factor met `gemeten / voorspeld`.

Dezelfde factor geldt voor de daggrafiek, de drie-uurs-API, de opgeslagen PV-voorspellingen en alle apparaatadviezen. De AC-limiet blijft per omvormer gelden. Instraling, GTI en ontvangen Growatt- en HomeWizard-metingen worden niet vermenigvuldigd. Na herstart worden lopende en toekomstige PV-cachewaarden opnieuw berekend uit de opgeslagen instraling, zonder extra weerverzoek en met behoud van de oorspronkelijke ophaaltijd. De voorspellingendpoints vermelden de toegepaste `calibration_factor`.

### Automatisch corrigeren met Growatt

Elk klokkwartier heeft een **eigen onafhankelijke correctie**. Het Open-Meteo-punt van 14:15 hoort bij het gemiddelde van 14:00–14:15. Een factor van 0.8 corrigeert dat gemeten blok en wordt voor **14:00–14:15 van vandaag, morgen en overmorgen** gebruikt zolang dat blok nog geen eigen goedgekeurde correctie heeft. 14:15–14:30 en andere klokkwartieren nemen die factor niet over. Voor ieder klokkwartier zonder eigen correctie kiest ZonAPI de nieuwste beschikbare eerdere meetdag voor precies dat klokkwartier, ook als die meting ouder is dan gisteren. Ontbreekt zo'n referentie, dan blijft de factor 1. Ook factor nul geldt alleen voor dat klokkwartier.

De factor wordt toegepast op de **eigen actuele weerverwachting van de voorspelde dag**. Bij factor 0.8 en een basisvoorspelling van 1000 W vandaag en 1500 W morgen worden de voorspellingen dus 800 W en 1200 W. De historische wattages en paneelgroepen worden niet gekopieerd. Vandaag gebruiken goedgekeurde blokken hun eigen gedateerde correctie; blokken die nog op metingen of de bewolkingscontrole wachten gebruiken een referentie van een eerdere kalenderdag. De Nederlandse dagovergang verwijdert die referentie niet. Een eigen nieuwe correctie krijgt direct voorrang.

De standaardmodus is `per_block`. Bestaande instellingen met `live_today_pattern` of `pattern` worden bij het lezen automatisch als `per_block` behandeld. Je hoeft je eigen settings.json niet aan te passen. De laatste factor wordt uitsluitend als informatie getoond en is geen terugvalwaarde voor een ander blok.

**Nieuwe correcties vereisen onbewolkte uren.** Het bestaande gecombineerde Open-Meteo-verzoek haalt naast GHI/DNI/DHI ook `cloud_cover` en `weather_code` per uur op, vanaf de huidige kalenderdag. Eerdere uurpunten die voor een wachtende correctie nodig zijn, komen uit de al opgeslagen bewolkingshistorie. Dit voegt geen weerverzoeken toe en verandert het ingestelde minuteninterval niet. Een uurpunt is uitsluitend **onbewolkt** bij exact **0% totale bewolking én weercode 0 (helder)**. Een andere waarde is niet volledig onbewolkt; een ontbrekende of ongeldige waarde is onbekend en geeft geen goedkeuring. Het zijn modelgegevens volgens de [Open-Meteo-documentatie](https://open-meteo.com/en/docs), geen lokale waarnemingen of garantie dat er bij de panelen geen wolk langs kwam.

De controle omvat het **hele kwartier plus minstens een uur ervoor en een uur erna**. Voor het blok **09:00–09:15** is dat **08:00–10:15**. Omdat bewolking als oorspronkelijke uurpunten wordt opgehaald, controleert ZonAPI conservatief ook de omringende uurpunten: in dit voorbeeld **08:00, 09:00, 10:00 en 11:00**. Er wordt niet geïnterpoleerd om ontbrekende uurwaarden als helder te beschouwen. De beschikbare modelpunten worden **direct gebruikt, ook als ze in de toekomst liggen**. Het controlevenster hoeft niet verstreken te zijn en de weerdata hoeft niet daarna opnieuw te worden opgehaald. In dit voorbeeld kan de correctie dus worden berekend zodra het volledige Growatt-meetdrietal beschikbaar is en alle genoemde uurpunten 0% bewolking en weercode 0 aangeven. Een om 09:05 opgehaalde heldere verwachting voor 10:00 en 11:00 mag meteen meetellen. Dit is een controle volgens de weerverwachting; wachten maakt deze modelgegevens niet tot lokale waarnemingen.

Verse meetdrietallen worden eerst bewaard in `pv_correction_candidates`, samen met de ongecorrigeerde referentiebasis en de gebruikte meetwaarden. Er wordt dan nog geen nieuwe factor berekend of toegepast. De productiedienst voert de heldere-hemelcontrole in dezelfde aanroep uit en berekent en bewaart de factor direct bij goedkeuring. Dit werkt ook als de oorspronkelijke Growatt-metingen ondertussen ouder dan de actuele versheidsgrens zijn: hun geldigheid is bij ontvangst gecontroleerd en de bewaarde invoer wordt niet als actuele opbrengst gepresenteerd. De gewone versheidscontrole voor nieuwe meetdrietallen blijft bestaan.

Wachtende kwartieren worden na iedere meetronde en geslaagde weeropvraag opnieuw beoordeeld, ook na een herstart. Eén weeropvraag kan meerdere wachtende kwartieren afhandelen. Bij voorspelde bewolking of ontbrekende/onbekende uurpunten blijft de eerdere geldige correctie gelden. Het dashboard en Growatt-blok tonen de concrete wachtreden; ook met een bestaande factor blijft die reden zichtbaar. De tooltip vermeldt het venster en, zodra beschikbaar, de hoogste bewolking. Bij goedkeuring met toekomstige uurpunten staat erbij dat de bewolkingsverwachting direct is gebruikt. Kandidaten blijven maximaal 48 uur bewaard; bewolkingshistorie maximaal vier dagen. Logboeken wissen verandert deze opslag niet. Bestaande correcties worden niet gewist. Oude kandidaten met een later opgeslagen controletijdstip worden bij een herstart meteen opnieuw beoordeeld; dat tijdstip blokkeert de berekening niet. Er zijn geen nieuwe instellingen of databasemigratie nodig.

Iedere correctie gebruikt nog steeds drie volledige Growatt-totalen: **vijf minuten vóór, rond en vijf minuten na de Open-Meteo-bronklok**. Voor 09:15 zijn dat 09:10, 09:15 en 09:20; de uitkomst geldt voor **09:00–09:15** op die datum. De echte meettijd bepaalt de koppeling, met maximaal 150 seconden afstand tot het dichtstbijzijnde vijfminutenmoment. Precies halverwege wordt het volgende moment gekozen. Per omvormer en moment telt alleen de dichtstbijzijnde meting; bij gelijke afstand krijgt de nieuwste ontvangen versie voorrang. Eén echte meettijd vult nooit twee momenten. Alle verwachte omvormers moeten aanwezig zijn.

De oude standaardwaarde `sample_tolerance_seconds: 90` wordt automatisch als 150 behandeld, zodat bijvoorbeeld een echte meting om 09:12:46 niet wordt afgewezen. Andere expliciete grenzen binnen 0–150 blijven gelden. De originele meettijden en blauwe grafiekpunten blijven behouden. Een ontbrekend moment wordt niet opgevuld met oude data. Het meetdrietal wacht op alle drie momenten; bij vijf minuten aanleververtraging kan de invoer voor 09:15 bijvoorbeeld bij de opvraag om 09:25 klaarstaan. Met heldere modelpunten voor het vereiste venster volgt de correctie meteen in die meetronde; er is geen extra wachttijd tot het latere uur.

ZonAPI zoekt het meest overeenkomende paar binnen de drie totalen. De uitschietergrens is `max(outlier_min_w, outlier_relative × gemiddelde_van_dat_paar)`. Standaard moet de derde meting meer dan 35% én meer dan 200 W van dat paar afwijken; het verschil binnen het paar mag hoogstens de helft van die grens zijn. Alleen dan wordt één uitschieter voor de correctie genegeerd. Anders blijven alle drie metingen behouden. De ruwe gegevens worden altijd bewaard.

De factor is `gemiddelde_gemeten_w / basisvoorspelling_w`, met handmatige kalibratie in de basis en zonder eerdere automatische correctie. `[800, 2000, 820] W` wordt bijvoorbeeld `810 W` na het filter. Bij een basis van `1000 W` levert dit factor `0.81` oftewel -19% op voor het eigen klokkwartier. De bronperiode en de basiswaarden per paneelgroep worden bij het gemeten blok bewaard. Een nieuwe weeropvraag verandert daardoor niet ongemerkt de rekenreferentie van die historische correctie. Een nieuw meetdrietal wordt tegen de dan beschikbare ongecorrigeerde bron gevalideerd. Tijdens het wachten blijft de opgeslagen referentiebasis behouden. Na goedkeuring wordt alleen de eigen correctie vervangen; factoren worden niet opgestapeld.

**Iedere dag opnieuw leren.** De opslag gebruikt model, datum en begin-/eindtijd als sleutel. Het drietal voor 09:15 van vandaag maakt daardoor een eigen kandidaat, ook als gisteren voor 09:15 al een factor bestond. Iedere nieuwe complete Growatt-meetronde valideert de recentste beschikbare invoer en beoordeelt de bewaarde kandidaten. Na goedkeuring ontstaat een eigen correctierij voor vandaag. Gewijzigde metingen kunnen de invoer opnieuw voorbereiden; een ongewijzigde kandidaat wordt niet dubbel opgeslagen. De vorige meetdag blijft als historie bestaan. Zolang een meetmoment ontbreekt, de bron bij ontvangst te oud is, de basisopwek te laag is of de hemelcontrole geen goedkeuring geeft, ontstaat geen nieuwe gemeten correctie en blijft de eerdere dagfactor als voorspelschatting gelden. Er worden geen ontbrekende metingen of bewolkingswaarden verzonnen.

Bij uurterugval wordt het oorspronkelijke uurvak verdeeld in effectieve kwartierblokken, met behoud van het originele middelpunt voor de zonnegeometrie. Heeft één daarvan een correctie, dan nemen de overige drie die factor niet over. Datums en UTC-begin-/eindtijden zijn onderdeel van de opslagsleutel. Ook de twee gelijknamige gemeten klokkwartieren tijdens de wintertijdwisseling blijven aparte blokken. Een ongemeten herhaald klokkwartier van vandaag gebruikt uitsluitend een eerdere kalenderdag als terugval, niet het andere gelijknamige kwartier van vandaag. De koppeling volgt **Europe/Amsterdam**, niet een verschuiving van steeds 24 uur. Zijn tijdens de wintertijd twee gelijknamige kwartieren gemeten, dan dient de laatste daarvan als referentie voor dat klokkwartier op toekomstige dagen. Het kwartier 23:45–00:00 hoort bij de dag waarop het begint.

Dezelfde gecorrigeerde blokwaarden gelden voor alle daggrafieken, ESP32-endpoints, apparaatadviezen en PV-cache. Het startadvies per dag rekent iedere fase van de volledige apparaatcyclus door met de correctie van het betreffende kwartier, na aftrek van basislast, reserve en het verbruik van actieve apparaten. Dit bepaalt zowel het eerste geschikte startmoment als het alternatief **Meeste zon**, per programma. Bij een nieuwe correctie werkt de dienst het eigen gemeten cacheblok en de overeenkomstige klokkwartieren op latere kalenderdagen in één transactie bij; buurkwartieren blijven ongewijzigd. Bij herstart worden ook de overgenomen correcties van vandaag opnieuw toegepast, inclusief verstreken blokken met zo'n referentie. Na een geslaagde weeropvraag worden de factoren op de nieuwe verwachtingen toegepast en controleert ZonAPI de beschikbare recente meetgegevens en alle wachtende kandidaten opnieuw, zonder extra bronverzoek. De AC-limiet blijft per omvormer gelden.

Optionele instellingen; behoud je eigen `calibration_factor`:

```json
"pv": {
  "calibration_factor": 1.0,
  "automatic_correction": {
    "enabled": true,
    "mode": "per_block",
    "min_forecast_w": 100,
    "max_factor": 3,
    "max_skew_seconds": 300,
    "sample_tolerance_seconds": 150,
    "outlier_relative": 0.35,
    "outlier_min_w": 200
  }
}
```

| Instelling | Standaard | Betekenis |
| --- | --- | --- |
| `enabled` | `true` | Leren en toepassen aan/uit; opgeslagen blokken blijven bewaard. |
| `mode` | `per_block` | Uitsluitend het eigen gedateerde blok; oude modinamen worden automatisch overgezet. |
| `min_forecast_w` | `100` | Minimale totale basisopwek om te leren (>0–20000 W). |
| `max_factor` | `3` | Bovengrens van de factor (1–10); neerwaarts is nul toegestaan. |
| `max_skew_seconds` | `300` | Maximale onderlinge spreiding van de omvormerklokken (0–3600 seconden). |
| `sample_tolerance_seconds` | `150` | Maximale afstand tot het vijfminutenmoment (0–150); de oude standaard `90` wordt `150`. |
| `outlier_relative` | `0.35` | Relatieve uitschietergrens (>0–2). |
| `outlier_min_w` | `200` | Absolute uitschietergrens in het totale installatievermogen (0–20000 W). |

Op het dashboard staat naast het percentage het eigen tijdvak, bijvoorbeeld **Blok 14:00–14:15**, en **Blokken vandaag 1/96**. Bij zomer-/wintertijd kan een kalenderdag 92 of 100 blokken tellen. De tooltip vermeldt de datum, de drie meetmomenten en een eventueel genegeerde uitschieter. Zolang leren nog niet kan, staat er een concrete wachtreden en het aantal ontvangen momenten of omvormers.

`GET /intern/api/v1/pv/corrections` geeft `mode: "per_block"`, `scope: "independent_quarters"`, `today_policy: "own_block_then_previous_day_same_clock_quarter"`, `future_day_policy: "same_clock_quarter"`, `latest.start`, `latest.end`, `latest.date`, de bron-/meetwaarden en de onderbouwing in `sampling`. `learned_blocks` telt alle opgeslagen blokken voor het model; `learned_blocks_today` en het compatibiliteitsveld `learned_quarters` tellen uitsluitend de **eigen gemeten** blokken van vandaag. Een overgenomen eerdere dagfactor verhoogt die teller niet. `learned_clock_quarters` telt de beschikbare afzonderlijke klokkwartieren. `quarters` beschrijft de echte gedateerde kwartieren van vandaag, inclusief ontbrekende eigen factoren (`null`). Voorspelslots houden `base_power_w`, `power_w`, `automatic_correction_factor` en `correction_source`; de herkomst is `block` voor een eigen gemeten correctie, `same_clock_quarter` voor hergebruik van een eerdere meetdag op vandaag of toekomstige dagen en `none` voor de basis. `correction_reference_start` en `correction_reference_end` wijzen naar het gemeten bronblok. `correction_computed_at` geeft het laatste berekentijdstip van die toegepaste correctie als UTC ISO-datum, of `null` zonder correctie. Dit veld is ook beschikbaar in de openbare dashboardsnapshot. Hiervoor zijn geen nieuwe instellingen of databasemigratie nodig.

In de Database-pagina staan goedgekeurde correcties in **`pv_block_corrections`**, met `start_ms` en `end_ms`. Bij de eerdere migratie naar onafhankelijke blokken (schema 6) worden oude correcties alleen overgenomen als hun onderbouwing een eenduidige `target_time` bevat. De oude `pv_correction_pattern` blijft als archief bestaan en wordt niet meer gebruikt voor berekeningen. Overgenomen factoren in andere cacheblokken worden teruggezet naar de bewaarde basiswaarden. Originele weer-, Growatt- en HomeWizard-metingen blijven behouden.

De volledige heldere-hemelonderbouwing staat bij een goedgekeurd blok in `sampling.clear_sky`, met het gevraagde venster, de omringende uurpunten, ophaaltijden en gecontroleerde bewolkingswaarden. `uses_forecast` geeft aan of toekomstige uurpunten zijn gebruikt. Nieuwe berekeningen geven geen `waiting_for_clear_sky_window` of toekomstig `ready_at` meer. Wacht-/afwijsredenen zijn `clear_sky_data_missing` voor ontbrekende/onbekende waarden, `clouds_present` voor bewolking en `waiting_for_clear_sky_data` voor gegevens met een ongeldige toekomstige ontvangsttijd. De openbare snapshot toont alleen de daarvoor toegestane venster- en statusvelden.

De laatste leerpoging blijft los van de logschakelaar beschikbaar in `diagnostic_state` bij `source='growatt'`, `name='pv_correction'`, en als `last_attempt` in de correctie-API. Logging uitschakelen of logs wissen verwijdert geen onafhankelijke blokcorrecties. Een gewijzigd paneelmodel, locatie of handmatige kalibratie krijgt een eigen modelhash en neemt geen correcties van het oude model over.

### Database-indeling

SQLite gebruikt schemaversie 7 (`PRAGMA user_version`). Bij starten worden `weather_conditions` en `pv_correction_candidates` toegevoegd. Bestaande onafhankelijke blokcorrecties en metingen blijven behouden. Eenduidig gedateerde oude correcties worden overgenomen; socketstatus en meetgeschiedenis blijven behouden. De belangrijkste scheiding is:

| Tabel | Sleutel en inhoud |
| --- | --- |
| `forecast` | Oorspronkelijke instraling per broninterval; een nieuwere bronwaarde overschrijft hetzelfde interval. |
| `pv_forecast` | Per paneelgroep en interval: `base_power_w`, gecorrigeerd `power_w`, `correction_factor`, `computed_ms` en `model_key`. `fetched_ms` blijft de oorspronkelijke weerophaaltijd. |
| `pv_block_corrections` | Eén onafhankelijke rij per `model_key + start_ms + end_ms`, met factor, basis-/meetvermogen, meet-/bijwerktijd, meetsignatuur en onderbouwing inclusief de ongecorrigeerde paneelgroepen. |
| `weather_conditions` | Oorspronkelijke bewolkingsuurpunten per locatie en UTC-tijd, met percentage, weercode, model en ophaaltijd. Oudere aanleveringen overschrijven geen nieuwere waarden; nieuwere onbekende waarden worden niet als nul ingevuld. |
| `pv_correction_candidates` | Nog te beoordelen invoer per model en blokeindtijd, met meetdrietal, referentiebasis, signatuur en eerste controletijd. Dit zijn geen toegepaste correcties. |
| `pv_correction_pattern` | Archief van de eerdere klokpatronen. Alleen ondubbelzinnig gedateerde oude correcties worden bij de migratie overgenomen. |
| `inverter_measurements` / `cloud_inverter_measurements` | Ongewijzigde ontvangen vermogens- en energiemetingen per omvormer en meettijd. |
| `appliance_socket_state` | Eén actuele toestand per apparaat-id, met configuratiesleutel, laatste meettijd, vermogen en bevestigde start-/stoptijden. Nieuwe uitlezingen overschrijven dezelfde rij. |
| `appliance_cycles` / `appliance_cycle_samples` | Begrensde cyclusmetadata en vermogen per meettijd, met twee afgesloten cycli en maximaal één startkandidaat/lopende cyclus per apparaat. Verwijderen van een cyclus verwijdert ook de bijbehorende meetpunten. |
| Growatt-/weer-/meterlogtabellen | Losse, begrensde diagnosegegevens; wissen of uitschakelen verwijdert geen kwartierpatronen of opbrengstmetingen. |

Meet- en berekentijden staan in UTC-milliseconden. De correctiesleutel bevat de echte begin-/eindtijd, zodat gemeten kwartieren op verschillende dagen of tijdens de wintertijdwisseling onafhankelijk bewaard blijven. Zonder eigen correctie gebruikt vandaag het nieuwste bijpassende Nederlandse klokkwartier uit een eerdere kalenderdag; toekomstige dagen gebruiken de nieuwste beschikbare referentie. Een correctie en het bijwerken van het eigen cacheblok plus overeenkomstige toekomstige klokkwartieren worden in één transactie opgeslagen.

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

Alle volledige gegevens- en beheerroutes gebruiken de prefix `/intern`. Alleen het dashboard en zijn beperkte, vaste snapshot zijn openbaar. Bestaande ESP32's en eigen scripts moeten hun ZonAPI-adressen van `/api/v1/...` aanpassen naar `/intern/api/v1/...`; de oude routes hebben geen alias of redirect. De API van de fysieke HomeWizard-apparaten zelf verandert niet.

| Pad | Resultaat |
| --- | --- |
| `GET /api/v1/dashboard` | Openbare alleen-lezen snapshot met uitsluitend dashboardwaarden: huidige totalen, drie daggrafieken, correcties, apparaten, dagelijkse startadviezen en cyclusgrafieken. Geen keuzemogelijkheid voor interne tabellen of brongegevens. |
| `GET /intern` | Interne ingang; toont de Growatt-beheerpagina. Ook bereikbaar op `/intern/`. |
| `GET /intern/database` | Interne databasebrowser met tabelkeuze, sortering, filters en paginering. |
| `GET /intern/api/v1/database/tables` | Interne catalogus van toepassingstabellen en kolommen. |
| `GET /intern/api/v1/database/rows?table=forecast` | Interne gepagineerde tabelinhoud. |
| `GET /intern/api/v1/forecast?hours=3` | GHI/DNI/DHI en eigen PV-berekening voor komende uren; `power_w:null` met ontbrekende configuratie als panelen nog niet ingesteld zijn. |
| `GET /intern/api/v1/forecast/day` | Voorspelling voor vandaag uit de cache met zonsopkomst/-ondergang en aangrenzende tijdvakken; optioneel `?date=YYYY-MM-DD` voor een andere kalenderdag. |
| `GET /intern/api/v1/forecast/days` | Vandaag, morgen en overmorgen met eigen datums, zonuren en gecorrigeerde voorspelslots; leest uitsluitend de cache. |
| `GET /intern/api/v1/pv/corrections` | Onafhankelijke gedateerde blokcorrecties, laatste eigen tijdvak en de kwartieren van vandaag. |
| `GET /intern/api/v1/irradiance?hours=3` | Instraling per kwartier met uurterugval en berekende GTI per paneelgroep. |
| `GET /intern/api/v1/production/current` | Afzonderlijke omvormers plus uitsluitend bij vier verse metingen een betrouwbare som. |
| `GET /intern/api/v1/production/day` | Totale opbrengst per meetronde van vandaag, met bron, groepeertijd, aantal omvormers en zonsopgang/-ondergang. |
| `GET /intern/api/v1/growatt?limit=50` | Feitelijke TCP-luisterstatus/fout, actieve databasepad, ontvangen pakkettypen/statussen, omvormers en recente fouten; maximaal 100 pakketten per aanvraag. |
| `GET /intern/api/v1/growatt/cloud` | Webbronstatus en herkende installaties/omvormers zonder token. |
| `POST /intern/api/v1/growatt/cloud/poll` | Eén ophaalpoging als het ingestelde interval en eventuele foutwachttijd verstreken zijn. |
| `GET /intern/api/v1/growatt/cloud/calls/:id` | HTTP-metadata en geschoond JSON-antwoord van één opgeslagen webverzoek. |
| `GET /intern/api/v1/weather?status=all&limit=50&offset=0` | Weerstatus, aangemaakte aanvraag-URL, zoninstraling van vandaag en gefilterde, pagineerbare aanvragen met HTTP-status en foutreden. Statusfilter: `all`, `ok`, `error`, `pending`. |
| `POST /intern/api/v1/weather/refresh` | Probeert direct eenmaal het weer op te halen, ook 's nachts, met behoud van pauze en overlapbeveiliging; resultaat bevat `attempted`, `reason` en bijgewerkte status. |
| `GET /intern/api/v1/:source/logging` | Logstatus voor `growatt`, `weather` of `homewizard`. |
| `PUT /intern/api/v1/:source/logging?enabled=false` | Logging uitzetten in `debug.json`; `enabled=true` zet logging aan. |
| `DELETE /intern/api/v1/weather/diagnostics` | Wist weerlogs met behoud van teller, minutenplanning, instraling en actuele status. |
| `GET /intern/api/v1/homewizard?device=all&status=all&limit=50&offset=0` | Lokale meterinformatie, actuele bronstatus en gefilterde verzoeken. `device`: `all`, `p1`, `kwh`; `status`: `all`, `ok`, `error`. |
| `POST /intern/api/v1/homewizard/poll` | Leest eenmaal de ingestelde lokale meters. |
| `DELETE /intern/api/v1/homewizard/diagnostics` | Wist meterlogs met behoud van meetgeschiedenis en actuele status. |
| `GET /intern/api/v1/growatt/timeline?type=xx04&limit=100` | Chronologische lijst van pakketten, TCP-gebeurtenissen en webverzoeken, met filters `type` (`xx04` of `5004`), `address` (`50`–`53`), `view` (`all`, `packets`, `errors`, `events`, `cloud`) en paginering via `offset`. `has_more` geeft aan of er meer regels zijn. |
| `GET /intern/api/v1/growatt/frames/:id` | Eén ontvangen pakket inclusief de oorspronkelijke hex-inhoud en eventuele gedecodeerde meting. |
| `DELETE /intern/api/v1/growatt/diagnostics` | Verwijdert Growatt-pakketten en verbindings-/antwoordlogs, behoudt opgeslagen opbrengstmetingen; geeft verwijderde aantallen terug. De Growatt-pagina biedt hiervoor een knop met bevestiging. |
| `GET /intern/api/v1/meters/current` | P1 en kWh afzonderlijk, plus precies **één** gekozen netto netvermogen. Positief = import, negatief = export. |
| `GET /intern/api/v1/history?metric=irradiance&from=...&to=...` | Bestaande time series. `metric`: `irradiance`, `pv_forecast`, `inverter`, `p1` of `kwh`; `limit` max. 5000. Bij `inverter` kiest optioneel `source=shinelink`, `cloud` of `auto` de bron; standaard geldt de ingestelde opbrengstbron. Bij voorspellingen overschrijft een nieuwere bronwaarde hetzelfde tijdvak. |
| `GET /intern/api/v1/appliances` | Geldige JSON-profielen, programma's met hun stappen en duur, socketstatus en eventuele laad-/validatiefouten. |
| `GET /intern/api/v1/appliances/daily` | Per voorspelde lokale dag zontijden en startadviezen voor ieder apparaat en programma. |
| `GET /intern/api/v1/appliances/wasmachine/advice` | Apparaatsamenvatting en `programs` met per programma `can_start_now`, `earliest_start`, `best_start`, zonnefractie en status. Kandidaten noemen programma-id en naam. Optioneel `?program=<id-of-naam>`; ook beschikbaar voor andere apparaat-id's. |
| `GET /intern/api/v1/status` | Bronnen, configuratiefouten, historisch aantal ontvangen frames, zontijden, minuteninterval, informatieve dagteller en volgende weersophaling. |
| `GET /dashboard` | Ruime daggrafieken voor vandaag, morgen en overmorgen, elk tussen eigen zonuren, met verbonden voorspeltijdvakken en tijd-/waardecursor; vandaag ook gemeten totaalpunten en huidige-tijdlijn. |
| `GET /intern/growatt` | Growatt-pagina met omvormermetingen, tijdlijn voor pakketten, antwoorden, tijdsynchronisatie en verbindingen, filters, verwijderknop en verversing iedere 15 seconden. |
| `GET /intern/weather` | Weerpagina met zontijden, bronverzoeken, fouten, instralingsgrafiek en handmatige ophaalknop, verversing iedere 15 seconden. |
| `GET /intern/homewizard` | Lokale meterinformatie, poll-logs, filters, logbeheer en handmatig ophalen; verversing iedere 15 seconden. |

Bijvoorbeeld voor een ESP32: lees `can_start_now` alleen als `status === "ok"`; bij `null`, `stale` of ontbrekende instellingen toon je "onbekend" in plaats van "nee". `earliest_start` kan na drie uur liggen. `best_start` en `best` bevatten het moment met de meeste zonne-energie, ook als de minimumdrempel nergens wordt gehaald. Deze velden staan eveneens per apparaat in `/intern/api/v1/appliances/daily`. De nieuwe `solar_share` is de ongeronde fractie (0–1); `solar_share_percent` blijft het leesbare percentage met maximaal één decimaal. De vergelijking van startmomenten en minimumdrempels gebruikt de ongeronde fractie, zodat afronden geen gedeeltelijke dekking als 100% presenteert. Een bruikbaar gedeeltelijk alternatief vereist `status === "ok"` en `0 < best.solar_share < 1`; houd ook rekening met `already_active` of de socketstatus.

## Growatt-validatie bij eerste live-verbinding

1. Laat de dienst eerst lokaal draaien, verplaats daarna het ingestelde ShineLanBox-serveradres. De decoder ontvangt op de ingestelde TCP-poort; de software heeft geen uitgaand Growatt-adres en gebruikt geen proxy.
2. Bekijk `/intern/api/v1/status`: `frames` toont `decoded:...`, `unknown_layout`, `bad_crc` en dergelijke; de individuele omvormers staan er met meettijd. In `config/layouts/README.md` staat het schema voor alternatieve layouts.
   Via `/intern/growatt` zijn de berichttypen, ontvangen bytes en TCP-gebeurtenissen direct in de browser te bekijken. Kies `xx04` om ook eerdere meetpakketten te vinden die niet bij de laatste honderd berichten staan. De knop Vernieuwen en het tijdstip Bijgewerkt tonen of nieuwe gegevens zijn opgehaald. De hex-inhoud kan serienummers bevatten.
   ShineLanBox-v06-aanmeldingen met type `5003`–`5303` of `5029`–`5329` tonen de adressen `50`–`53`, omvormerserienummers en logger. Open een `xx29`-pakket met **Bekijk** om per RF-stick het update-interval, de firmware, tijdzone en apparaatklok te lezen. In de vier verstrekte voorbeelden meldt adres `50` 5 minuten en melden adressen `51`–`53` elk 1 minuut. Deze pakketten bevatten geen actuele vermogensmeting; daarvoor is een datarecord nodig (`xx04` of `xx50`).
3. Vergelijk meerdere werkelijk gemeten wattages en energietellers **per serienummer** met de eigen omvormers. Controleer herverbinding en of oudere gebufferde pakketten niet het actuele vermogen vervangen. Gebruik desgewenst lokaal `node scripts/inspect-frames.js` voor pakketstatus; `--hex` toont privégegevens, waaronder serienummers.
4. Bij uitsluitend lokaal gebruik kun je externe Growatt-verbindingen met de firewall blokkeren. Voor cloudgebruik moet de ShineLanBox Growatt wel kunnen bereiken. De TCP-ontvanger stuurt in geen van beide standen pakketten of cloudopdrachten door. Of jouw ShineLanBox 7.0.0.4 de generieke ACK van de lokale TCP-server accepteert, kan pas met de echte hardware worden bevestigd. Als dat niet zo is, zijn de bewaarde pakketten de input voor een gerichte protocolaanpassing.

Een ontvangen `5004` verschijnt als omvormermeting onder het serienummer van adres `50`. Bij de lokale bron wordt de totale actuele opbrengst pas gevuld wanneer alle vier omvormers een recente meting hebben. De grafiek bundelt deze waarden tot één totaalpunt; individuele metingen blijven zichtbaar op `/intern/growatt`. Bekijk na elk bericht `reply_sent` in `/intern/growatt` voor de lokaal geschreven antwoordbytes. ZonAPI schrijft de ACK vóór het decoderen; direct daarna volgt op de eerste geldige `xx03` een lokale `0118`-tijdsopdracht voor dataloggerregister 31. Bij ontbrekende `xx04`-pakketten herhaalt de opdracht hoogstens eenmaal per tien minuten, zolang er `xx03`-pakketten binnenkomen. `time_sync_sent` logt de uitgaande bytes, `time_sync_response` logt een eventueel binnenkomend `xx18`-antwoord. `reply_sent` betekent dat Node de bytes aan de socket heeft overgedragen; controleer de daaropvolgende pakketten om het effect op de logger te zien. Nieuwe TCP-verbindingen en normale sluitingen staan tussen de berichten; na 30 minuten stilte volgt `idle_disconnect`. De listener gebruikt geen TCP-keepalive met korte probe-termijn. `DELETE /intern/api/v1/growatt/diagnostics` wist alleen diagnostische berichten; de opbrengsthistorie blijft aanwezig door een automatische SQLite-migratie bij de eerste start van deze versie.

## Testen

`npm test` controleert de scheiding tussen openbare en interne HTTP-routes, het weglaten van technische velden uit de openbare snapshot, geweigerde openbare schrijfmethoden, de echte dashboardmodule met uitsluitend de openbare snapshot, interne beheerpagina's en hun bestanden, debugbestandbeheer en dashboard-logschakelaars, behoud van metingen en planning met logging uit, vaste minutenintervallen zonder dagmaximum rond zomer-/wintertijd, drie daggrafieken met eigen zonuren en cursors bij verschillende schermbreedtes, geleerde kwartiercorrecties voor toekomstige dagen, Growatt-frequentiebeperking en meettijden, bronkeuze zonder dubbeltelling, TCP-verwerking, database-migraties, kwartier-/uurselectie, HomeWizard en apparaatadviezen. Programmatests controleren validatie, behoud van oude profielen, apparaatminimum en algemene terugval, afzonderlijke starttijden en zonnedekking, programmakeuze via HTTP, publieke gegevensafscherming, dashboardweergave, configuratiewijzigingen tijdens bedrijf en één socketuitlezing per fysiek apparaat. De tests gebruiken lokale fixtures en simulaties van de externe bronnen. De berekendatum wordt gecontroleerd bij vertraagde goedkeuring, hergebruik op alle drie dagen, kwartiergrenzen, 0%-correcties en smalle popups. Deze versie slaagt voor **269 tests**.

De regressies voor vandaag controleren de Nederlandse dagovergang, nieuwe weerdata, openbare en interne daggrafieken, programma-adviezen met basislast en reserve, ontbrekende en later complete meetdrietallen, herstel van de cache bij herstart, wintertijd en het kwartier tot middernacht. Een simulatie over drie opeenvolgende dagen leert dagelijks twee kwartieren uit de echte driepuntsleerfunctie en controleert de nieuwe factoren, afzonderlijke dateringen, bewaarde historie en het uitblijven van stapeling.

De onbewolkt-tests controleren directe correctie bij het laatste Growatt-meetpunt met eerder opgehaalde heldere verwachtingen, strikte nulbewolking én heldere weercodes op alle uurpunten aan beide kanten, voorspelde bewolking, ontbrekende/ongeldige waarden, locatie- en modelscheiding, hervatting na herstart en een mislukte opslag, oude kandidaten met een toekomstig controletijdstip, het verwerken van meerdere kwartieren per weeropvraag en de openbare wachtmelding met behoud van de vorige geldige factor.

De weericoontests controleren categorieën, ontbrekende uren, herhaalde wintertijduren, drie afzonderlijke dagen, kwartieruitlijning en onderlinge afstand bij verschillende breedtes, de popup na horizontaal schuiven, gegevensafscherming en de positie van het startadvies boven de grafieken. De gerenderde SVG-grafieken zijn visueel gecontroleerd op 280 en 1180 pixels.

De bewolkingsregressies controleren de koppeling van modelparen aan de instralingsdekking, Best Match-terugval, onvolledige paren en gemengde antwoordvormen, uurmodus, wintertijd, percentagedrempels, afwijkende algemene weercodes, verouderde data en veilige herkomstvelden in alle drie daggrafieken.
