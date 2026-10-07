# Blokktérkép – Marosvásárhely

Offline is használható térkép a marosvásárhelyi tömbházakról: blokkszámok, házszámok és lépcsőházak (Sc. A/B/C…). Futároknak készült navigációs segédlet.

Az adatok **kizárólag az OpenStreetMapből** származnak (© OpenStreetMap közreműködők, ODbL), meg abból, amit mi magunk írunk be a `data/overrides.csv` fájlba. Más (zárt) térképszolgáltatásból, például a Glovo Rider appból semmit nem veszünk át.

## Adatok frissítése

```bash
cd ~/Documents/Programming/courier-mures-map
python3 fetch_data.py            # letölti az OSM-adatokat (1–3 perc)
python3 fetch_data.py --from-raw # újrafeldolgozás letöltés nélkül
```

A program kiírja a lefedettséget (hány blokknak van száma, hány lépcsőház van jelölve, negyedenként).

## Megnyitás a gépen

```bash
python3 -m http.server 8000
```

Utána böngészőben: <http://localhost:8000>

## Saját kiegészítések: `data/overrides.csv`

Ha egy blokkon hiányzik a szám, vagy rossz, vagy nincs jelölve egy lépcsőház, írd be ide. **Ami ebben a fájlban van, az felülírja az OSM-adatot.**

```csv
lat,lon,label,type,street,note
46.546210,24.571830,Bl. 14,block,Strada Ialomița,festve a falon
46.546105,24.571650,A,entrance,,hátsó bejárat
```

| oszlop | jelentés |
|---|---|
| `lat`, `lon` | koordináta (tizedesponttal) |
| `label` | blokknál pl. `Bl. 14` vagy `14A`; lépcsőháznál elég `A` (így jelenik meg: `Sc. A`) |
| `type` | `block`, `entrance` vagy `place` (névvel kereshető hely, pl. egy bolt, ami hiányzik az OSM-ből) |
| `street` | utca (nem kötelező) |
| `note` | megjegyzés, megjelenik az épület kártyáján (nem kötelező) |

**Koordináta szerzése:** a térképen koppints az épületre. A kártya alján ott a koordináta, onnan kimásolható. Másik megoldás: Google Mapsben hosszan nyomod a pontot, és kimásolod a számokat.

**Hogyan érvényesül:**
- `block`: ha a pont egy épület körvonalán belül van, annak az épületnek a felirata lecserélődik (lila keret jelzi). Ha nincs ott épület, új lila pont kerül a térképre.
- `place`: új, névvel kereshető hely jön létre (pl. `46.5442,24.5571,Shopping City,place,Strada X,`), és navigálni is lehet hozzá.
- `entrance`: ha 8 méteren belül van egy OSM-bejárat, annak a felirata cserélődik. Ha nincs, új bejárat jön létre, és a legközelebbi (50 m-en belüli) épülethez kapcsolódik.
- A `#`-tel kezdődő sorokat a program kihagyja.
- Mentés után elég frissíteni az oldalt, a `fetch_data.py`-t nem kell újra futtatni.

**Csak saját megfigyelést írj be** (amit a falon látsz, vagy amit biztosan tudsz). Más térképalkalmazásból ne másolj adatot.

**Tipp:** ha van kedved, ugyanezt közvetlenül az OpenStreetMapbe is beírhatod (openstreetmap.org → Szerkesztés; blokknál `addr:block`, bejáratnál `entrance=staircase` + `ref=A`). Akkor a következő `fetch_data.py` futtatás magától behozza, és mindenkinek jó lesz.

## Weboldal mindenkinek (GitHub Pages, ingyenes)

A térkép egy sima statikus weboldal, ingyen futhat GitHub Pagesen, saját domain nélkül.

1. A repó legyen **nyilvános** (Settings → General → Danger Zone → Change visibility). Privát repóból a Pages csak fizetős GitHub-csomaggal megy. Az adatok nyilvános OSM-adatok, a repóban nincs titkos dolog.
2. **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save.**
3. Pár perc múlva elérhető: `https://aloinarq.github.io/courier-mures-map/` – bárki megnyithatja, fiók nélkül.
4. Telefonon telepíthető appként:
   - **iPhone (Safari):** Megosztás → *Főképernyőhöz adás*
   - **Android (Chrome):** ⋮ menü → *Alkalmazás telepítése*

Frissítés: `python3 fetch_data.py`, aztán commit + push a `main`-re. A telefon a következő megnyitáskor behúzza az új adatokat.

## Helyzet és útvonal

- Első megnyitáskor a térkép elmagyarázza, mire kell a helymeghatározás, és csak az **Engedélyezés** gombra kérdez rá a böngésző.
- A kék pont a valós idejű helyzeted, a narancs legyező a haladási irány. A helyzet gomb: első koppintás követés, második kikapcsolja a követést. Ha elhúzod a térképet, a követés leáll.
- Bármelyik épületnél **Navigálás**: útvonal autóval, biciklivel vagy gyalog, becsült idővel és érkezéssel. **Indulás** után kanyarról kanyarra vezet, ha letérsz, újratervez, a célnál szól. Egy lépcsőház/bejárat koppintásával egyenesen oda vezet.
- Az útvonalat **a telefon számolja** a saját OSM-utcahálózatunkból (`route.js`): nincs szerver, nincs API-kulcs, offline is működik. Az egyirányú utcákat és körforgalmakat figyelembe veszi, a bekanyarodási tilalmakat nem – mindig a táblákat kövesd.
- A helymeghatározás csak HTTPS-en (GitHub Pages) vagy localhoston működik.

## Offline és háttértérkép

- Az utcák, utcanevek, blokkok, házszámok, lépcsőházak és az útvonaltervezés **letöltés nélkül is működnek offline** (az első megnyitás után).
- A **Háttértérkép** (Beállítások) az OpenStreetMap saját csempéit mutatja: ingyenes, kulcs nélküli, de internet kell hozzá, és a szabályzatuk tiltja a tömeges letöltést. Ezért csak a megnézett csempék mentődnek el.

## Élő forgalom (TomTom)

A Beállításokban bekapcsolható **Élő forgalom** a TomTom Traffic Flow csempéit teszi a térképre: csak ott látszik szín, ahol a forgalom lassabb a szokásosnál (narancs → piros → sötétpiros). 3 percenként frissül, internet kell hozzá.

Beállítás egyszer:

1. Regisztrálj ingyen: <https://developer.tomtom.com> (bankkártya nem kell). Az ingyenes csomag napi 50 000 csempekérést ad; ha elfogy, aznapra leáll, nem számláz.
2. A Dashboardon hozz létre egy API kulcsot (**API & SDK keys**). A kulcsnál kapcsold be a **Domain whitelisting**-et, és add meg: `aloinarq.github.io` (helyi teszthez: `localhost`). Termékként elég a **Traffic API**.
3. Írd be a kulcsot a `config.js` fájlba: `tomtomKey: "IDE_A_KULCS"`, majd commit + push.

A kulcs látszik az oldal forrásában – térképkulcsoknál ez így szokás –, de a domain-korlátozás miatt más weboldal nem tudja használni. Kulcs nélkül a forgalom kapcsoló egyszerűen nem jelenik meg.

## Nyelvek

Az app angolul (alapértelmezett), magyarul és románul érhető el. A nyelv a Beállításokban (rétegek gomb) választható, és a telefon megjegyzi.

A szövegek a `lang/` mappában vannak: `en.js`, `hu.js`, `ro.js`. Mindhárom fájlban ugyanazoknak a kulcsoknak kell lenniük; a `{n}`, `{msg}` stb. helyőrzőket az app tölti ki. Új nyelvhez másold le az `en.js`-t (pl. `de.js`), fordítsd le, és vedd fel az `index.html`-be és az `sw.js` listájába. A „Bl.”, „Sc.” és „nr.” rövidítés minden nyelven marad, mert így van kiírva a házakon.

## Fájlok

- `fetch_data.py`: OSM-letöltés (Overpass API) és feldolgozás
- `index.html`, `app.js`, `style.css`: a térkép
- `config.js`: a TomTom forgalmi kulcs helye (élő forgalom)
- `data/pois.geojson`: névvel kereshető helyek (boltok, éttermek, gyógyszertárak, iskolák…), OSM-ből
- `route.js`: offline útvonaltervező (A* a saját utcahálózaton)
- `lang/`: angol, magyar, román szövegek
- `sw.js`, `manifest.webmanifest`: offline mód / telepíthető app
- `vendor/leaflet/`: Leaflet 1.9.4 helyben, CDN nélkül
- `fonts/`: Google Sans (a Google Térkép betűtípusa, SIL OFL), helyben, hogy offline is meglegyen
- `data/blocks.geojson`, `data/entrances.geojson`, `data/roads.geojson`, `data/context.geojson`, `data/stats.json`: generált adatok
- `data/overrides.csv`: saját kiegészítések
