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
| `type` | `block` vagy `entrance` |
| `street` | utca (nem kötelező) |
| `note` | megjegyzés, megjelenik a buborékban (nem kötelező) |

**Koordináta szerzése:** a térképen koppints az épületre. A buborék alján ott a koordináta, onnan kimásolható. Másik megoldás: Google Mapsben hosszan nyomod a pontot, és kimásolod a számokat.

**Hogyan érvényesül:**
- `block`: ha a pont egy épület körvonalán belül van, annak az épületnek a felirata lecserélődik (lila keret jelzi). Ha nincs ott épület, új lila pont kerül a térképre.
- `entrance`: ha 8 méteren belül van egy OSM-bejárat, annak a felirata cserélődik. Ha nincs, új bejárat jön létre, és a legközelebbi (50 m-en belüli) épülethez kapcsolódik.
- A `#`-tel kezdődő sorokat a program kihagyja.
- Mentés után elég frissíteni az oldalt, a `fetch_data.py`-t nem kell újra futtatni.

**Csak saját megfigyelést írj be** (amit a falon látsz, vagy amit biztosan tudsz). Más térképalkalmazásból ne másolj adatot.

**Tipp:** ha van kedved, ugyanezt közvetlenül az OpenStreetMapbe is beírhatod (openstreetmap.org → Szerkesztés; blokknál `addr:block`, bejáratnál `entrance=staircase` + `ref=A`). Akkor a következő `fetch_data.py` futtatás magától behozza, és mindenkinek jó lesz.

## Telefonra (GitHub Pages + offline mód)

1. Készíts egy GitHub repót (pl. `courier-mures-map`, lehet nyilvános is, hiszen az adatok nyilvános OSM-adatok).
2. A projekt mappájában:
   ```bash
   git init && git add . && git commit -m "Blokktérkép"
   git branch -M main
   git remote add origin https://github.com/FELHASZNALONEV/courier-mures-map.git
   git push -u origin main
   ```
3. GitHubon: **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**. Pár perc múlva elérhető ezen a címen: `https://FELHASZNALONEV.github.io/courier-mures-map/`
4. Telefonon nyisd meg a címet:
   - **iPhone (Safari):** Megosztás → *Főképernyőhöz adás*
   - **Android (Chrome):** ⋮ menü → *Alkalmazás telepítése* / *Hozzáadás a kezdőképernyőhöz*
5. Wi-Fi-n nyomd meg a **⤓** gombot: letölti a háttértérképet (13–16-os nagyítás az egész városra, 17–18 a beépített részekre). Ezután térerő nélkül is működik. A blokkok, számok és lépcsőházak adatai az első megnyitáskor maguktól elmentődnek.

Frissítés: `python3 fetch_data.py`, aztán `git add . && git commit -m "adatfrissítés" && git push`. A telefon a következő megnyitáskor (térerővel) behúzza az új adatokat.

A „Helyzetem” gomb csak HTTPS-en (GitHub Pages) vagy localhoston működik, sima `http://192.168…` címen nem.

## Fájlok

- `fetch_data.py`: OSM-letöltés (Overpass API) és feldolgozás
- `index.html`, `app.js`, `style.css`: a térkép
- `sw.js`, `manifest.webmanifest`: offline mód / telepíthető app
- `vendor/leaflet/`: Leaflet 1.9.4 helyben, CDN nélkül
- `data/blocks.geojson`, `data/entrances.geojson`, `data/stats.json`: generált adatok
- `data/overrides.csv`: saját kiegészítések

Háttértérkép: CARTO Light (OSM-alapú). A CARTO ingyenes csempéi kis, nem kereskedelmi forgalomra valók. Személyes használatra rendben van, nagy tömegű terjesztéshez saját csempeszolgáltató kell.
