# Identifiants de service et fonds confirmés

Chaque abonnement dispose d’un coffre séparé pour l’email et le mot de passe du service. Ne pas utiliser ce coffre pour un mot de passe de boîte mail ou des données de carte bancaire/CVC. Le responsable configure les identifiants du service après avoir choisi son compte chez ce fournisseur. Enregistrer une valeur dans ce coffre ne crée aucun compte tiers et ne change pas son mot de passe.

## Protection

Les valeurs sont chiffrées au repos en AES-256-GCM avec IV aléatoire et authentification liée à l’abonnement. La clé dédiée VAULT_ENCRYPTION_KEY réside dans les secrets de l’hébergement. Le login commun suggéré vient de VAULT_DEFAULT_LOGIN_EMAIL et reste hors du code. Une rotation de clé demande une réécriture chiffrée des données existantes ; perdre cette clé rend les anciennes données illisibles.

Les métadonnées ne contiennent aucun secret. L’affichage demande une requête explicite, contrôlée par session, cercle et abonnement. Les responsables peuvent gérer le coffre. Un participant ordinaire doit être actif et avoir payé la période courante de Paris. La permission est relue atomiquement après déchiffrement, avec comparaison de l’enveloppe chiffrée exacte et des preuves financières. Les réponses ne sont pas mises en cache. Le journal note l’acteur, l’action et l’abonnement, jamais les valeurs.

Le client efface les identifiants de son état après masquage, changement de visibilité ou une minute ; aucun localStorage ni URL ne contient le secret. Cela ne peut pas effacer une valeur déjà copiée par une personne. Au départ d’un membre, le responsable doit changer le mot de passe chez le fournisseur pour révoquer son usage réel.

## Génération locale

Le bouton de proposition utilise seulement crypto.getRandomValues et une liste locale de128mots. Sept mots, quatre chiffres et un symbole donnent environ65,3bits d’entropie avant modification. Aucun appel IA, token, réseau ou coût de génération. Le responsable peut modifier la proposition avant sauvegarde.

## Argent arrivé à la banque

Une facture prestataire marquée paid ne suffit pas. La révélation exige aussi une ligne billing_bank_receipts liée à cette facture : crédit booked en EUR, montant couvrant la facture, compte bancaire exact VAULT_BANK_ACCOUNT_ID, référence bancaire distincte et dates comptabilisées valides. Une annulation ou suppression de preuve retire l’accès. Aucune route du navigateur ne peut déclarer un paiement reçu.

Cette publication ne configure aucun connecteur bancaire ni ingestion authentifiée. Sans preuve de crédit et identifiant bancaire attendu, les accès des participants aux identifiants restent verrouillés. Les tests utilisent seulement une base fictive. Les propriétaires et administrateurs conservent leur accès de gestion du coffre.

## Raccordement bancaire restant

Revolut Open Banking exige un prestataire réglementé et des certificats de production : https://developer.revolut.com/docs/guides/build-banking-apps/introduction-to-the-open-banking-api/who-can-access-the-api . Une connexion AIS en lecture seule peut détecter les crédits, mais ne prélève personne.

Enable Banking propose l’évaluation avec comptes propres liés : https://enablebanking.com/docs/api/linked-accounts/ . La gratuité et l’exposition d’une application publique doivent être vérifiées selon les conditions de l’opérateur ; voir https://enablebanking.com/terms/ et https://enablebanking.com/docs/faq/ . La compatibilité du type de compte et du pays visés doit être vérifiée pendant un consentement officiel. Ce dépôt ne configure aucun compte, contrat, consentement bancaire, prélèvement, achat ou fonction d’utilisation de carte.
