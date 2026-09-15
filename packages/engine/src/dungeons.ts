/** The four dungeons, as data. Room effects use the script DSL. */
import type { Effect } from './script.js';

export interface Room {
  name: string;
  effects: Effect[];
  next: string[];
}
export interface Dungeon {
  name: string;
  start: string;
  rooms: Record<string, Room>;
}

const t = (name: string, typeLine: string, power: string, toughness: string, colors: ('W' | 'U' | 'B' | 'R' | 'G')[], keywords?: string[]) => ({ name, typeLine, power, toughness, colors, keywords });

export const DUNGEONS: Record<string, Dungeon> = {
  'Lost Mine of Phandelver': {
    name: 'Lost Mine of Phandelver',
    start: 'Cave Entrance',
    rooms: {
      'Cave Entrance': { name: 'Cave Entrance', effects: [{ kind: 'scry', amount: 1 }], next: ['Goblin Lair', 'Mine Tunnels'] },
      'Goblin Lair': { name: 'Goblin Lair', effects: [{ kind: 'createToken', token: t('Goblin', 'Creature — Goblin', '1', '1', ['R']), count: 1 }], next: ['Storeroom', 'Dark Pool'] },
      'Mine Tunnels': { name: 'Mine Tunnels', effects: [{ kind: 'treasure' }], next: ['Dark Pool', 'Fungi Cavern'] },
      Storeroom: { name: 'Storeroom', effects: [{ kind: 'chooseObjects', filter: { types: ['Creature'], zone: 'battlefield' }, count: 1, key: 'room', upTo: true }, { kind: 'addCounters', counter: '+1/+1', amount: 1, on: { ref: 'chosen', key: 'room' } }], next: ['Temple of Dumathoin'] },
      'Dark Pool': { name: 'Dark Pool', effects: [{ kind: 'loseLife', amount: 1, who: { ref: 'eachOpponent' } }, { kind: 'gainLife', amount: 1 }], next: ['Temple of Dumathoin'] },
      'Fungi Cavern': { name: 'Fungi Cavern', effects: [{ kind: 'chooseObjects', filter: { types: ['Creature'], zone: 'battlefield' }, count: 1, key: 'room', upTo: true }, { kind: 'pump', power: -4, toughness: 0, on: { ref: 'chosen', key: 'room' }, duration: 'untilYourNextTurn' }], next: ['Temple of Dumathoin'] },
      'Temple of Dumathoin': { name: 'Temple of Dumathoin', effects: [{ kind: 'draw', amount: 1 }], next: [] },
    },
  },
  'Tomb of Annihilation': {
    name: 'Tomb of Annihilation',
    start: 'Trapped Entry',
    rooms: {
      'Trapped Entry': { name: 'Trapped Entry', effects: [{ kind: 'loseLife', amount: 1, who: { ref: 'eachPlayer' } }], next: ['Veils of Fear', 'Oubliette'] },
      'Veils of Fear': { name: 'Veils of Fear', effects: [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'unlessPays', who: { ref: 'iter' }, cost: 'discard', effects: [{ kind: 'loseLife', amount: 2, who: { ref: 'iter' } }], text: 'Discard a card? Otherwise lose 2 life.' }] }], next: ['Sandfall Cell'] },
      Oubliette: { name: 'Oubliette', effects: [{ kind: 'discard', amount: 1 }, { kind: 'sacrificeChoice', who: { ref: 'controller' }, filter: { types: ['Artifact'], zone: 'battlefield' }, count: 1 }, { kind: 'sacrificeChoice', who: { ref: 'controller' }, filter: { types: ['Creature'], zone: 'battlefield' }, count: 1 }, { kind: 'sacrificeChoice', who: { ref: 'controller' }, filter: { types: ['Land'], zone: 'battlefield' }, count: 1 }], next: ['Cradle of the Death God'] },
      'Sandfall Cell': { name: 'Sandfall Cell', effects: [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'unlessPays', who: { ref: 'iter' }, cost: 'sacrifice', effects: [{ kind: 'loseLife', amount: 2, who: { ref: 'iter' } }], text: 'Sacrifice an artifact, creature or land? Otherwise lose 2 life.' }] }], next: ['Cradle of the Death God'] },
      'Cradle of the Death God': { name: 'Cradle of the Death God', effects: [{ kind: 'createToken', token: { ...t('The Atropal', 'Creature — God Horror', '4', '4', ['B'], ['Deathtouch']), legendary: true }, count: 1 }], next: [] },
    },
  },
  'Dungeon of the Mad Mage': {
    name: 'Dungeon of the Mad Mage',
    start: 'Yawning Portal',
    rooms: {
      'Yawning Portal': { name: 'Yawning Portal', effects: [{ kind: 'gainLife', amount: 1 }], next: ['Dungeon Level'] },
      'Dungeon Level': { name: 'Dungeon Level', effects: [{ kind: 'scry', amount: 1 }], next: ['Goblin Bazaar', 'Twisted Caverns'] },
      'Goblin Bazaar': { name: 'Goblin Bazaar', effects: [{ kind: 'treasure' }], next: ['Lost Level'] },
      'Twisted Caverns': { name: 'Twisted Caverns', effects: [{ kind: 'chooseObjects', filter: { types: ['Creature'], zone: 'battlefield' }, count: 1, key: 'room', upTo: true }, { kind: 'applyRule', rule: { kind: 'cantAttack' }, on: { ref: 'chosen', key: 'room' }, duration: 'untilYourNextTurn' }], next: ['Lost Level'] },
      'Lost Level': { name: 'Lost Level', effects: [{ kind: 'scry', amount: 2 }], next: ['Runestone Caverns', "Muiral's Graveyard"] },
      'Runestone Caverns': { name: 'Runestone Caverns', effects: [{ kind: 'exileTop', amount: 2 }, { kind: 'playFromExile', what: { ref: 'lastMoved' }, duration: 'thisTurn' }], next: ['Deep Mines'] },
      "Muiral's Graveyard": { name: "Muiral's Graveyard", effects: [{ kind: 'createToken', token: t('Skeleton', 'Creature — Skeleton', '1', '1', ['B'], ['Menace']), count: 2 }], next: ['Deep Mines'] },
      'Deep Mines': { name: 'Deep Mines', effects: [{ kind: 'scry', amount: 3 }], next: ["Mad Wizard's Lair"] },
      "Mad Wizard's Lair": { name: "Mad Wizard's Lair", effects: [{ kind: 'draw', amount: 3 }, { kind: 'revealTop', then: [{ kind: 'may', effects: [{ kind: 'castWithoutPaying', what: { ref: 'lastMoved' } }], prompt: 'Cast the revealed card without paying its mana cost?' }], destination: 'stay' }], next: [] },
    },
  },
  Undercity: {
    name: 'Undercity',
    start: 'Secret Entrance',
    rooms: {
      'Secret Entrance': { name: 'Secret Entrance', effects: [{ kind: 'searchLibrary', filter: { types: ['Land'], supertypes: ['Basic'], zone: 'library' }, count: 1, destination: 'hand', reveal: true, shuffle: true }], next: ['Forge', 'Lost Well'] },
      Forge: { name: 'Forge', effects: [{ kind: 'chooseObjects', filter: { types: ['Creature'], zone: 'battlefield' }, count: 1, key: 'room', upTo: true }, { kind: 'addCounters', counter: '+1/+1', amount: 2, on: { ref: 'chosen', key: 'room' } }], next: ['Trap!', 'Arena'] },
      'Lost Well': { name: 'Lost Well', effects: [{ kind: 'scry', amount: 2 }], next: ['Arena', 'Stash'] },
      'Trap!': { name: 'Trap!', effects: [{ kind: 'loseLife', amount: 5, who: { ref: 'chosen', key: 'trapTarget' } }], next: ['Archives'] },
      Arena: { name: 'Arena', effects: [{ kind: 'chooseObjects', filter: { types: ['Creature'], zone: 'battlefield' }, count: 1, key: 'room', upTo: true }, { kind: 'goad', what: { ref: 'chosen', key: 'room' } }], next: ['Archives', 'Catacombs'] },
      Stash: { name: 'Stash', effects: [{ kind: 'treasure' }], next: ['Catacombs'] },
      Archives: { name: 'Archives', effects: [{ kind: 'draw', amount: 1 }], next: ['Throne of the Dead Three'] },
      Catacombs: { name: 'Catacombs', effects: [{ kind: 'createToken', token: t('Skeleton', 'Creature — Skeleton', '4', '1', ['B'], ['Menace']), count: 1 }], next: ['Throne of the Dead Three'] },
      'Throne of the Dead Three': { name: 'Throne of the Dead Three', effects: [{ kind: 'lookAtTop', amount: 10, then: 'battlefieldRestBottom', filter: { types: ['Creature'] }, pick: 1 }, { kind: 'addCounters', counter: '+1/+1', amount: 3, on: { ref: 'lastMoved' } }, { kind: 'grantKeywords', keywords: ['Hexproof'], on: { ref: 'lastMoved' }, duration: 'untilYourNextTurn' }], next: [] },
    },
  },
};
