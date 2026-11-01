# CheckMyM12

Page web (statique, sans serveur) qui liste, pour une commune ou un EPCI, les images [Panoramax](https://panoramax.fr)
portant le tag `osm|traffic_sign=FR:M12` **au niveau de l'image**, mais **sans annotation (zone)** indiquant
l'emplacement du panonceau dans l'image. La liste sert de liste de tâches : pour chaque image, ouvrir
Panoramax, dessiner la zone du panonceau, puis cocher « Traitée » (ou cliquer « Revérifier »).

## Utilisation

1. Ouvrir `index.html` dans un navigateur (en local, ou via GitHub Pages : *Settings → Pages → Deploy from a branch*).
2. Taper le nom, le code postal ou le code INSEE d'une commune, ou le nom ou le SIREN d'un EPCI
   (ex. « Eurométropole de Strasbourg », ou simplement « Strasbourg »), et choisir dans la liste.
3. Choisir la source :
   - **Toutes les instances** : méta-catalogue `api.panoramax.xyz` (couvre IGN, OSM France, etc.) ;
   - ou une instance précise (`panoramax.openstreetmap.fr`, `panoramax.ign.fr`, autre URL).
4. Cliquer sur **Rechercher**.

Pour chaque image :

- **Ouvrir dans Panoramax ↗** ouvre l'image sur son instance d'origine, où vous pouvez ajouter la zone ;
- **Revérifier** relit l'image sur son instance d'origine : si une annotation porte maintenant le tag
  (ou si le tag a été retiré de l'image), elle est marquée comme traitée ;
- **Traitée** : case à cocher manuelle.

L'état « traitée » est conservé dans le navigateur (`localStorage`). L'adresse de la page contient la
commune (ou l'EPCI) et la source : vous pouvez la mettre en favori pour relancer la même recherche.
**Exporter (CSV)** télécharge la liste (séparateur `;`).

Le tag recherché est modifiable dans « Tag recherché » (plusieurs valeurs possibles, séparées par des virgules).

## Fonctionnement

- Recherche et contour de la commune ou de l'EPCI : [geo.api.gouv.fr](https://geo.api.gouv.fr). S'il ne
  répond pas (erreur ou plus de 8 s), l'outil bascule sur la Géoplateforme IGN (WFS `BDTOPO_V3:commune` et
  `BDTOPO_V3:epci` sur `data.geopf.fr`) pour le reste de la session. En secours, la recherche se fait par
  nom, code INSEE ou SIREN (pas par code postal).
- Recherche : `GET /api/search?bbox=…&filter="semantics.osm|traffic_sign"='FR:M12'`.
  Ce filtre renvoie aussi les images dont le tag n'est présent que sur une annotation : l'outil ne garde
  que celles où le tag est dans `properties.semantics` (image) et dans aucune `properties.annotations[].semantics`.
- La commune (ou l'EPCI) est interrogée par cases d'environ 0,03° (≈ 2,5 km), en ne gardant que les cases qui touchent
  son contour : sur certaines instances (ex. `panoramax.ign.fr`), une recherche par tag sur une grande zone
  dense dépasse le délai du serveur et renvoie une erreur HTTP 500.
- Si une case renvoie une erreur serveur, elle est redécoupée en 4 (jusqu'à 2 fois). Les zones qui échouent
  encore sont signalées (liste possiblement incomplète) ; si rien ne répond, la recherche s'arrête avec l'erreur.
- `/api/search` n'est pas paginé : si une requête renvoie le maximum de résultats (1000), la case est
  découpée en 4 et chaque quart est interrogé à nouveau.
- Les images situées dans l'emprise mais hors du contour de la commune (ou de l'EPCI) sont écartées.
- Le méta-catalogue peut avoir un léger retard sur les instances ; « Revérifier » interroge directement
  l'instance d'origine.
