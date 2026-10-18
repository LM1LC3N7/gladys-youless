// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They
// never quote a text of the device: only our own words and error codes.
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const delay = (ms) =>
  ms >= 60_000
    ? { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` }
    : { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };

/** Our words for an error code of src/youless/client.js. */
const REASON = {
  timeout: { en: 'no answer', fr: 'pas de réponse' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  http: { en: 'HTTP error', fr: 'erreur HTTP' },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  not_data: { en: 'answer that is not data', fr: 'réponse qui n’est pas une donnée' },
  unknown_answer: { en: 'not a YouLess answer', fr: 'réponse qui n’est pas celle d’un YouLess' },
};

export function reason(err) {
  const text = REASON[err?.code] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
  const status = err?.code === 'http' && err.status ? ` ${err.status}` : '';
  return { en: `${text.en}${status}`, fr: `${text.fr}${status}` };
}

/** A message followed by notes (an index held back), each a { en, fr } text. */
export const withNotes = (message, notes = []) => ({
  en: [message.en, ...notes.map((n) => n.en)].join(' '),
  fr: [message.fr, ...notes.map((n) => n.fr)].join(' '),
});

export const T = {
  noAddress: {
    en: 'Enter the address of your YouLess (its IP address on your network, e.g. 192.168.1.50).',
    fr: 'Saisissez l’adresse de votre YouLess (son adresse IP sur votre réseau, ex. 192.168.1.50).',
  },
  badAddress: {
    en: 'The YouLess address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.50).',
    fr: 'L’adresse du YouLess n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.50).',
  },
  // `notes` (the failures): { en, fr } texts added after the message (an index held back).
  unreachable: (address, err, wait, notes = []) =>
    withNotes(
      {
        en: `The YouLess at ${address} could not be read (${reason(err).en}): new try in ${delay(wait).en}.`,
        fr: `Le YouLess à l’adresse ${address} n’a pas pu être lu (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  auth: (wait, notes = []) =>
    withNotes(
      {
        en: `The YouLess refused the password: check it and save. New try in ${delay(wait).en}.`,
        fr: `Le YouLess a refusé le mot de passe : vérifiez-le et enregistrez. Nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  protected: (wait, notes = []) =>
    withNotes(
      {
        en: `The YouLess asks for a password (it answers its login page): enter it in the configuration. New try in ${delay(wait).en}.`,
        fr: `Le YouLess demande un mot de passe (il répond par sa page de connexion) : saisissez-le dans la configuration. Nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  noDevice: (model) => ({
    en: `YouLess ${model} found: create its device from the "Discover" tab to receive its values.`,
    fr: `YouLess ${model} trouvé : créez son appareil depuis l’onglet « Découverte » pour recevoir ses valeurs.`,
  }),
  downgrade: (address, wait, notes = []) =>
    withNotes(
      {
        en: `The YouLess at ${address} now answers like another model (or without its MAC address) than the created device: its values are paused so as not to create a second device nor change the billed index. New try in ${delay(wait).en}. If you replaced the YouLess, delete the old device.`,
        fr: `Le YouLess à l’adresse ${address} répond maintenant comme un autre modèle (ou sans son adresse MAC) que l’appareil créé : ses valeurs sont suspendues pour ne pas créer un second appareil ni changer l’index facturé. Nouvel essai dans ${delay(wait).fr}. Si vous avez remplacé le YouLess, supprimez l’ancien appareil.`,
      },
      notes,
    ),
  /** `notes`: { en, fr } texts added after the connection message. */
  ok: (model, address, notes = []) =>
    withNotes(
      {
        en: `Connected to the YouLess ${model} (${address}).`,
        fr: `Connecté au YouLess ${model} (${address}).`,
      },
      notes,
    ),
  notes: {
    phases: {
      en: 'The phases page does not answer: the other values go on.',
      fr: 'La page des phases ne répond pas : les autres valeurs continuent.',
    },
    p1Outage: {
      en: 'The P1 meter gives no index right now: the consumption index waits for it.',
      fr: 'Le compteur P1 ne donne pas d’index en ce moment : l’index de consommation l’attend.',
    },
    noIndex: {
      en: 'The P1 tariffs of the meter give no consistent index right now (one of them at 0 or going down alone): the consumption index waits for them.',
      fr: 'Les tarifs P1 du compteur ne donnent pas d’index cohérent en ce moment (l’un à 0 ou en baisse seul) : l’index de consommation les attend.',
    },
    held: ({ direction, from, to }) => {
      if (direction === 'down') {
        return {
          en: `The consumption index dropped from ${from} to ${to} kWh: held back, the last accepted value is sent again. If the meter was really replaced or reset, click "Accept the held index" in the configuration of the integration: nothing is billed for the drop, the consumption goes on from there. Saving the configuration accepts nothing.`,
          fr: `L’index de consommation a baissé de ${from} à ${to} kWh : retenu, la dernière valeur acceptée est renvoyée. Si le compteur a vraiment été remplacé ou remis à zéro, cliquez sur « Accepter l’index retenu » dans la configuration de l’intégration : rien n’est facturé pour la baisse, la consommation repart de là. Enregistrer la configuration n’accepte rien.`,
        };
      }
      const kwh = Math.round((to - from) * 1000) / 1000;
      return {
        en: `The consumption index jumped from ${from} to ${to} kWh: held back, not sent to the energy monitoring. If you click "Accept the held index" in the configuration of the integration, ${kwh} kWh will be counted at once as consumption; accept only if this energy was really consumed. Saving the configuration accepts nothing.`,
        fr: `L’index de consommation a sauté de ${from} à ${to} kWh : retenu, non envoyé au suivi énergétique. Si vous cliquez sur « Accepter l’index retenu » dans la configuration de l’intégration, ${kwh} kWh seront comptés d’un coup comme consommation ; n’acceptez que si cette énergie a vraiment été consommée. Enregistrer la configuration n’accepte rien.`,
      };
    },
  },
  accept: {
    nothing: {
      en: 'No consumption index is held back: nothing to accept.',
      fr: 'Aucun index de consommation n’est retenu : rien à accepter.',
    },
    up: ({ from, to }) => {
      const kwh = Math.round((to - from) * 1000) / 1000;
      return {
        en: `Accepted: the index ${to} kWh will be sent at the next read, and ${kwh} kWh (plus what the home uses meanwhile) will be counted at once as consumption. A different value stays held.`,
        fr: `Accepté : l’index ${to} kWh sera envoyé à la prochaine lecture, et ${kwh} kWh (plus ce que le foyer consomme d’ici là) seront comptés d’un coup comme consommation. Une autre valeur reste retenue.`,
      };
    },
    down: ({ from, to }) => ({
      en: `Accepted: the index goes from ${from} down to ${to} kWh at the next read; 0 kWh is counted for the drop, the consumption goes on from there. A different value stays held.`,
      fr: `Accepté : l’index passe de ${from} à ${to} kWh à la prochaine lecture ; 0 kWh est compté pour la baisse, la consommation repart de là. Une autre valeur reste retenue.`,
    }),
  },
  test: {
    ok: (model, snapshot) => {
      const power = snapshot.power === undefined ? '?' : `${snapshot.power} W`;
      const index =
        snapshot.consumption.total === undefined ? '?' : `${snapshot.consumption.total} kWh`;
      return {
        en: `YouLess ${model} read: power ${power}, consumption index ${index}.`,
        fr: `YouLess ${model} lu : puissance ${power}, index de consommation ${index}.`,
      };
    },
    slow: {
      en: 'The YouLess is slow to answer: look at the integration status in a minute.',
      fr: 'Le YouLess tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
  },
};
