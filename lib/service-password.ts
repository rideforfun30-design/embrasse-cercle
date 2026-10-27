/**
 * Local-only service password suggestions. Never sends data to a server or AI.
 * Seven independent words, 10,000 numeric suffixes and eight symbols give
 * 7 * log2(128) + log2(10,000) + log2(8) = 65.2877 bits before any user edits.
 * Capitalization and separators are fixed and are not counted as entropy.
 */
export const SERVICE_PASSWORD_WORDS: readonly string[] = Object.freeze([
  "Abricot", "Acajou", "Alpaga", "Ananas", "Ancre", "Arlequin", "Arrosoir", "Avocat",
  "Babiole", "Badaboum", "Bambou", "Banane", "Banjo", "Basilic", "Bateau", "Biscuit",
  "Bobine", "Bonbon", "Bourdon", "Brioche", "Cabane", "Cacao", "Cactus", "Cajou",
  "Canard", "Capybara", "Caramel", "Cascade", "Cerise", "Chanson", "Chapeau", "Chaton",
  "Chouette", "Citron", "Clavier", "Cobalt", "Cocotte", "Comete", "Confetti", "Crayon",
  "Dahlia", "Domino", "Doudou", "Dragon", "Eclair", "Ecureuil", "Encrier", "Etoile",
  "Farfelu", "Ficelle", "Flamme", "Flocon", "Fraise", "Fusain", "Galaxie", "Galette",
  "Girafe", "Grelot", "Guitare", "Hamac", "Hermine", "Hibou", "Haricot", "Indigo",
  "Jasmin", "Jongleur", "Joyau", "Kiwi", "Koala", "Lampion", "Lanterne", "Lavande",
  "Lezard", "Luciole", "Lutin", "Magenta", "Mandala", "Mangue", "Maracas", "Marmotte",
  "Melodie", "Mirage", "Muffin", "Nectar", "Nenuphar", "Nuage", "Octave", "Opaline",
  "Origami", "Ourson", "Panda", "Papaye", "Parasol", "Pastel", "Patate", "Piano",
  "Pinceau", "Pistache", "Plume", "Popcorn", "Poulpe", "Praline", "Quenotte", "Raclette",
  "Raisin", "Renard", "Rigolo", "Robot", "Ruban", "Safran", "Sardine", "Soleil",
  "Sorbet", "Studio", "Swing", "Tango", "Tatami", "Toboggan", "Tomate", "Tortue",
  "Toucan", "Vague", "Velours", "Volcan", "Wasabi", "Yoyo", "Zebre", "Zeste",
]);
export const SERVICE_PASSWORD_WORD_COUNT = 7;
export const SERVICE_PASSWORD_SYMBOLS = "!#$%&*+?";
const NUMERIC_SUFFIX_COUNT = 10_000;
const UINT32_RANGE = 0x1_0000_0000;

export const SERVICE_PASSWORD_ENTROPY_BITS =
  SERVICE_PASSWORD_WORD_COUNT * Math.log2(SERVICE_PASSWORD_WORDS.length)
  + Math.log2(NUMERIC_SUFFIX_COUNT) + Math.log2(SERVICE_PASSWORD_SYMBOLS.length);

export const SERVICE_PASSWORD_MAX_LENGTH =
  SERVICE_PASSWORD_WORD_COUNT * Math.max(...SERVICE_PASSWORD_WORDS.map(word => word.length))
  + SERVICE_PASSWORD_WORD_COUNT + 4 + 1;

function secureIndex(upperExclusive: number): number {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== "function") {
    throw new Error("La génération aléatoire sécurisée est indisponible. Ouvrez le site en HTTPS.");
  }
  const buffer = new Uint32Array(1);
  const limit = UINT32_RANGE - (UINT32_RANGE % upperExclusive);
  do {
    source.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % upperExclusive;
}

/** Generate a suggestion in the browser. Do not log or persist it until explicit save. */
export function generateServicePassword(): string {
  const words = Array.from({ length: SERVICE_PASSWORD_WORD_COUNT }, () =>
    SERVICE_PASSWORD_WORDS[secureIndex(SERVICE_PASSWORD_WORDS.length)]);
  const digits = String(secureIndex(NUMERIC_SUFFIX_COUNT)).padStart(4, "0");
  const symbol = SERVICE_PASSWORD_SYMBOLS[secureIndex(SERVICE_PASSWORD_SYMBOLS.length)];
  return words.join("-") + "-" + digits + symbol;
}
