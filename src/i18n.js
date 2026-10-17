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

export const T = {
  noAddress: {
    en: 'Enter the address of your YouLess (its IP address on your network, e.g. 192.168.1.50).',
    fr: 'Saisissez l’adresse de votre YouLess (son adresse IP sur votre réseau, ex. 192.168.1.50).',
  },
  badAddress: {
    en: 'The YouLess address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.50).',
    fr: 'L’adresse du YouLess n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.50).',
  },
  unreachable: (address, err, wait) => ({
    en: `The YouLess at ${address} could not be read (${reason(err).en}): new try in ${delay(wait).en}.`,
    fr: `Le YouLess à l’adresse ${address} n’a pas pu être lu (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
  }),
  auth: (wait) => ({
    en: `The YouLess refused the password: check it and save. New try in ${delay(wait).en}.`,
    fr: `Le YouLess a refusé le mot de passe : vérifiez-le et enregistrez. Nouvel essai dans ${delay(wait).fr}.`,
  }),
  protected: (wait) => ({
    en: `The YouLess asks for a password (it answers its login page): enter it in the configuration. New try in ${delay(wait).en}.`,
    fr: `Le YouLess demande un mot de passe (il répond par sa page de connexion) : saisissez-le dans la configuration. Nouvel essai dans ${delay(wait).fr}.`,
  }),
  noDevice: (model) => ({
    en: `YouLess ${model} found: create its device from the "Discover" tab to receive its values.`,
    fr: `YouLess ${model} trouvé : créez son appareil depuis l’onglet « Découverte » pour recevoir ses valeurs.`,
  }),
  downgrade: (address, wait) => ({
    en: `The YouLess at ${address} now answers like another model (or without its MAC address) than the created device: its values are paused so as not to create a second device nor change the billed index. New try in ${delay(wait).en}. If you replaced the YouLess, delete the old device.`,
    fr: `Le YouLess à l’adresse ${address} répond maintenant comme un autre modèle (ou sans son adresse MAC) que l’appareil créé : ses valeurs sont suspendues pour ne pas créer un second appareil ni changer l’index facturé. Nouvel essai dans ${delay(wait).fr}. Si vous avez remplacé le YouLess, supprimez l’ancien appareil.`,
  }),
  /** `notes`: { en, fr } texts added after the connection message. */
  ok: (model, address, notes = []) => ({
    en: [`Connected to the YouLess ${model} (${address}).`, ...notes.map((n) => n.en)].join(' '),
    fr: [`Connecté au YouLess ${model} (${address}).`, ...notes.map((n) => n.fr)].join(' '),
  }),
  notes: {
    phases: {
      en: 'The phases page does not answer: the other values go on.',
      fr: 'La page des phases ne répond pas : les autres valeurs continuent.',
    },
    p1Outage: {
      en: 'The P1 meter gives no index right now: the consumption index waits for it.',
      fr: 'Le compteur P1 ne donne pas d’index en ce moment : l’index de consommation l’attend.',
    },
    jump: ({ from, to }) => ({
      en: `The consumption index jumped from ${from} to ${to} kWh: held back, not sent to the energy monitoring. If it is right, save the configuration of the integration to accept it (the difference is then counted once as consumption).`,
      fr: `L’index de consommation a sauté de ${from} à ${to} kWh : retenu, non envoyé au suivi énergétique. S’il est juste, enregistrez la configuration de l’intégration pour l’accepter (la différence est alors comptée une fois comme consommation).`,
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
