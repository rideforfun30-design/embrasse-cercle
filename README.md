# Le cercle EMBRASSE

Un espace privé pour partager des abonnements entre créatifs : comptes individuels, accès sur approbation ou inscription directe, groupes, places disponibles, répartition du prix, demandes de participation et notifications par e-mail.

Ce dépôt contient le code public de l’application. Il ne contient aucune base de production, aucun compte utilisateur, aucune coordonnée bancaire, aucun secret et aucun historique du déploiement privé.

## Ce qui fonctionne

- Connexion par e-mail et mot de passe choisi, vérification de l’adresse et récupération du compte.
- Validation des demandes d’accès par un administrateur, ou inscription directe au cercle configuré selon le mode choisi.
- Création de cercles, invitations, abonnements et demandes de participation.
- Ajout du lien public d’un service : nom proposé, icône et accès au site, avec nom modifiable et secours par initiales.
- Calcul des parts selon les membres et gestion du préavis de départ.
- Préférences de notification et file d’envoi par Google Apps Script.
- Préparation des cotisations récurrentes, avec protections empêchant leur activation accidentelle.

Les paiements réels sont désactivés par défaut. La présence du module Stripe ne signifie pas qu’un paiement, une réserve ou un recouvrement est actif. Leur activation demande une configuration propre à l’opérateur, des essais et la validation du collecteur et du prestataire. Un prélèvement peut échouer ; le logiciel ne garantit pas les fonds.

## Installer et vérifier

Prérequis : Node.js **22.13 ou supérieur** et npm. Le serveur utilise React, Vinext, Cloudflare Workers, D1 et Drizzle.

```sh
git clone https://github.com/rideforfun30-design/embrasse-cercle.git
cd embrasse-cercle
npm run install:ci
npm test
npx tsc --noEmit
npm run build
```

`npm run dev` lance le développement sur `http://localhost:5173`. Après construction, `npm start` permet de tester le Worker localement. Les fichiers générés et les données D1 locales sont ignorés par Git.

## Initialiser une base locale

Après la première construction, appliquer les neuf fichiers SQL de `drizzle/` **une seule fois, dans l’ordre numérique**, sur une base locale vide. La commande suivante illustre le premier ; changer le nom du fichier pour chaque migration suivante :

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_hesitant_luminals.sql
```

La liaison D1 locale utilise un identifiant factice. Les migrations décrivent uniquement le schéma : aucune donnée de production n’est incluse. Sur une instance déjà initialisée, appliquer seulement les nouvelles migrations ; `0008_chief_dracula.sql` ajoute le lien du service et conserve les abonnements existants. Pour modifier le schéma, utiliser `npm run db:generate` puis relire le SQL généré.

## Configurer son instance

Prendre `.env.example` comme liste de paramètres. En local, définir les valeurs privées dans `.dev.vars` ; en hébergement, les enregistrer dans le gestionnaire de secrets de l’opérateur. Ne jamais les ajouter au dépôt.

- Définir **`ACCESS_CONTROL_ENABLED=true`** pour imposer l’approbation des accès ; cette valeur est conservée dans l’exemple de configuration. Pour autoriser l’inscription directe, définir explicitement `ACCESS_CONTROL_ENABLED=false` et `ACCESS_DEFAULT_WORKSPACE_ID` sur son propre cercle : un profil authentifié rejoint alors uniquement ce cercle, en rôle membre, dans les limites de capacité. L’adresse e-mail reste à vérifier avec la connexion par mot de passe ; ce mode n’ouvre aucun accès anonyme.
- Configurer `ACCESS_ADMIN_USER_IDS` avec les identifiants stables de ses propres administrateurs et, si nécessaire, `ACCESS_DEFAULT_WORKSPACE_ID` avec son propre cercle. Une adresse e-mail seule ne confère aucun pouvoir d’administration.
- Pour la connexion par e-mail : générer son propre `BETTER_AUTH_SECRET` aléatoire d’au moins 32 caractères, régler `BETTER_AUTH_URL` sur l’origine exacte de son instance, puis activer `AUTH_EMAIL_ENABLED` seulement après raccordement des notifications.
- Renseigner son propre destinataire administratif et l’identité Google autorisée. Ne pas utiliser les identifiants d’une autre instance.
- Laisser les indicateurs de paiement et de notification désactivés tant que les services correspondants n’ont pas été testés.

Le fichier `.openai/hosting.json` publié déclare seulement les liaisons génériques `DB` et R2. Il ne raccorde pas le dépôt à une instance existante. Un déploiement Sites nécessite son propre projet ; un autre hébergeur doit fournir les liaisons Worker/D1 et une authentification de confiance équivalentes.

`app/page.tsx` conserve les domaines de la version EMBRASSE et ses pages d’attente. Pour un autre déploiement, adapter ces règles de domaine et de redirection.

## E-mails Google Workspace

Créer son propre projet Google Apps Script sous le compte expéditeur autorisé :

1. Copier `scripts/google-mail-worker.gs` et le manifeste `scripts/google-mail-appsscript.json` dans le projet (`appsscript.json`). Remplacer `BUREAU_SITE` par l’URL HTTPS de sa propre instance.
2. Exécuter `connexionGoogle()` et autoriser les permissions demandées. Relever l’adresse et **l’audience OAuth réelle** affichées ; ne jamais enregistrer ou partager le jeton d’identité.
3. Configurer ces valeurs dans `NOTIFICATIONS_GOOGLE_EMAIL` et `NOTIFICATIONS_GOOGLE_AUDIENCE`, ainsi que `ADMIN_NOTIFICATION_EMAIL`. Activer `NOTIFICATIONS_DELIVERY_ENABLED` après vérification du raccordement.
4. Exécuter `installerLesNotifications()` pour installer le déclencheur à la minute. `arreterLesNotifications()` permet de l’arrêter.

Le script utilise `MailApp` pour envoyer des messages. Il ne lit pas la boîte Gmail. Le serveur vérifie la signature du jeton Google, son audience, son identité et son expiration. L’envoi dépend des quotas Google et ne garantit pas la réception en boîte principale.

## Architecture et sécurité

Les routes dans `app/api/` appliquent les contrôles d’identité, d’accès au site et d’appartenance au cercle côté serveur. Better Auth gère les sessions et le hachage des mots de passe. La robustesse des mots de passe est évaluée localement ; aucun mot de passe n’est envoyé à un service de notation.

Le nom d’un service est proposé localement depuis son domaine : le serveur ne télécharge pas le lien collé. Les URL de service sont limitées aux adresses publiques HTTP/HTTPS, sans identifiants, avec suppression de la recherche et du fragment. Les icônes sont chargées par le navigateur via Google Favicons, qui reçoit le nom de domaine du service ; si une icône échoue, les initiales prennent le relais. Voir aussi [le détail des liens et des modes d’inscription](docs/ajout-abonnement-par-lien.md).

Les adaptateurs `oai-authenticated-*` sont réservés à un hébergement de confiance qui établit lui-même ces en-têtes. Sur un autre hébergeur, ils doivent être supprimés des requêtes publiques ou remplacés par une authentification vérifiée. Le simulateur d’identité inclus dans les outils de développement est réservé au loopback local et n’appartient pas au build de production.

La suite de tests couvre notamment les accès, l’authentification, les notifications, le préavis et les garde-fous de paiement. Elle ne constitue pas une garantie d’absence de faille. Pour signaler un problème, éviter toute donnée personnelle, secret, mot de passe ou jeton dans les issues publiques.

## Organisation

- `app/`, `components/`, `hooks/` : interface et routes.
- `lib/` : règles d’accès, abonnements, cotisations et notifications.
- `db/`, `drizzle/` : schéma et migrations.
- `worker/` : point d’entrée Cloudflare et en-têtes de sécurité.
- `scripts/` : installation, développement, build et envoi Google.
- `tests/` : vérifications automatisées.

## Contributions et droits

Le code est consultable publiquement pour faciliter la compréhension et la collaboration. Aucune nouvelle licence générale de réutilisation n’est accordée par cette publication. Les composants tiers conservent leurs licences respectives ; voir `THIRD_PARTY_NOTICES.md` et les notices incluses. Ne jamais envoyer de données utilisateur ou de secrets dans une contribution.
