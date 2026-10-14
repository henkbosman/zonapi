# Optionele ShineLanBox-layouts

De ingebouwde parser heeft Grotts generieke T02NNNN, T05NNNN(X) en T06NNNN(X) offsets. Komt jouw firmware met een andere layout, plaats hier een JSON-bestand met de **exacte** sleutel uit een opgeslagen Growatt-frame, bijvoorbeeld `T065104.json` of bij een bericht boven 375 bytes `T065104X.json`:

```json
{ "serial": 38, "date": 68, "power": 101, "today": 131, "total": 135 }
```

Offsets zijn **bytes vanaf het begin van het ontsleutelde frame**, inclusief acht headerbytes. `serial` = 10 ASCII-bytes; `date` = 6 binaire bytes YY-MM-DD-hh-mm-ss in de Nederlandse tijdzone; `power`, `today` en `total` = elk 4 big-endian bytes, gedeeld door 10. Een voorbeeldbestand mag pas worden aangepast na vergelijking met echte metingen; willekeurige offsets geven onjuiste vermogens. Herstart de dienst na wijziging.

Onbekende pakketten blijven als privé-BLOB in `data/zonapi.sqlite` staan en krijgen status `unknown_layout` in `/api/v1/status`. Geef ongefilterde pakketten met serienummers niet publiek door.
