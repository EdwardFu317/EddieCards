import {
  App,
  ButtonComponent,
  Component,
  Editor,
  ItemView,
  MarkdownView,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
  TextComponent,
  TFile,
  FuzzySuggestModal,
  WorkspaceLeaf,
} from "obsidian";
import { createEmptyCard, fsrs, Rating, State, type Card as FsrsCard, type StepUnit } from "ts-fsrs";

const VIEW_TYPE_OB_KI = "ob-ki-decks";

type ReviewGrade = "again" | "hard" | "good" | "easy";
type CardType = "basic" | "exercise";

type GradeHotkeys = Record<ReviewGrade, string>;

interface AiPromptTemplate {
  id: string;
  name: string;
  prompt: string;
}

interface ObKiCard {
  id: string;
  type?: CardType;
  front: string;
  back: string;
  sourcePath?: string;
  sourceLine?: number;
  sourceLink?: string;
  sourceAnchor?: ObKiSourceAnchor;
  createdAt: number;
  updatedAt: number;
  dueAt: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reviews: number;
  lapses: number;
  state: State;
  lastReviewAt?: number;
  suspended?: boolean;
}

interface ObKiSourceAnchor {
  startOffset: number;
  endOffset: number;
  startLine: number;
  selectedText: string;
  beforeContext: string;
  afterContext: string;
}

interface ObKiReviewLog {
  id: string;
  cardId: string;
  grade: ReviewGrade;
  reviewedAt: number;
  wasNew: boolean;
}

interface ObKiDeckSettings {
  requestRetention?: number;
  maximumInterval?: number;
  dailyNewLimit?: number;
  dailyReviewLimit?: number;
  useCustomStudyOrder?: boolean;
}

type ObKiMicroDeckItem =
  | { type: "card"; cardId: string }
  | { type: "microDeck"; microDeck: ObKiMicroDeck };

interface ObKiMicroDeck {
  id: string;
  name: string;
  items: ObKiMicroDeckItem[];
}

interface ScrollSnapshot {
  root: number;
  main: number;
  anchorId: string;
  anchorOffset: number;
}

interface ObKiUndoReview {
  deckId: string;
  card: ObKiCard;
  loggedReviewId: string;
}

interface ObKiDeck {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  cards: ObKiCard[];
  reviewLog?: ObKiReviewLog[];
  settings?: ObKiDeckSettings;
  microDecks?: ObKiMicroDeck[];
  studyOrder?: ObKiMicroDeckItem[];
}

type ObKiDeckTreeItem =
  | { type: "deck"; deckId: string }
  | { type: "folder"; folder: ObKiDeckFolder };

interface ObKiDeckFolder {
  id: string;
  name: string;
  items: ObKiDeckTreeItem[];
}

interface ObKiData {
  decks: ObKiDeck[];
  activeDeckId?: string;
  deckIds?: string[];
  deckPaths?: Record<string, string>;
  deckOrder?: ObKiDeckTreeItem[];
  settings?: ObKiSettings;
}

interface ObKiBackupFile {
  app: "EddieCards";
  version: 1;
  exportedAt: number;
  data: ObKiData;
}

type HealthIssueType = "source-missing" | "wiki-missing" | "image-missing";

interface HealthIssue {
  type: HealthIssueType;
  deckId: string;
  deckName: string;
  cardId: string;
  cardFront: string;
  target: string;
  field: "来源" | "正面" | "背面";
}

interface ObKiSettings {
  createBasicCardHotkey: string;
  createExerciseCardHotkey: string;
  createMicroDeckHotkey: string;
  showAnswerHotkey: string;
  gradeHotkeys: GradeHotkeys;
  openViewAfterAdd: boolean;
  defaultDeckMode: "active" | "first";
  requestRetention: number;
  maximumInterval: number;
  enableFuzz: boolean;
  enableShortTerm: boolean;
  learningSteps: string;
  relearningSteps: string;
  autoRefreshSeconds: number;
  dailyNewLimit: number;
  dailyReviewLimit: number;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiModelOptions: string[];
  aiPromptTemplates: AiPromptTemplate[];
  activeAiPromptTemplateId?: string;
  enableReviewReminder: boolean;
}

const DEFAULT_DATA: ObKiData = {
  decks: [],
};

const DEFAULT_SETTINGS: ObKiSettings = {
  createBasicCardHotkey: "Mod+Shift+A",
  createExerciseCardHotkey: "Mod+Shift+E",
  createMicroDeckHotkey: "Mod+Shift+M",
  showAnswerHotkey: "Space",
  gradeHotkeys: {
    again: "Z",
    hard: "X",
    good: "C",
    easy: "V",
  },
  openViewAfterAdd: true,
  defaultDeckMode: "active",
  requestRetention: 0.9,
  maximumInterval: 36500,
  enableFuzz: true,
  enableShortTerm: true,
  learningSteps: "1m, 10m",
  relearningSteps: "10m",
  autoRefreshSeconds: 30,
  dailyNewLimit: 20,
  dailyReviewLimit: 200,
  aiBaseUrl: "https://api.openai.com/v1",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  aiModelOptions: [],
  aiPromptTemplates: [
    {
      id: "default-basic",
      name: "基础问答",
      prompt: "请从当前笔记中提取适合主动回忆的重点，制作高质量闪卡。每张卡正面应是明确问题，背面应是简洁但完整的答案。",
    },
    {
      id: "formula-exercise",
      name: "公式习题",
      prompt: "请把当前笔记中的公式、定理和推导制作成习题卡。题目只保留条件或问题，解答给出关键推导和结论。",
    },
  ],
  activeAiPromptTemplateId: "default-basic",
  enableReviewReminder: true,
};

export default class ObKiPlugin extends Plugin {
  data: ObKiData = DEFAULT_DATA;
  settings: ObKiSettings = DEFAULT_SETTINGS;
  lastUndo?: ObKiUndoReview;

  get dataDir() {
    return normalizePath(`${this.manifest.dir}/data`);
  }

  get decksDir() {
    return normalizePath(`${this.dataDir}/decks`);
  }

  get exportsDir() {
    return normalizePath(`${this.dataDir}/exports`);
  }

  async onload() {
    await this.loadObKiData();
    this.addSettingTab(new ObKiSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.enableReviewReminder) {
        const due = this.data.decks.reduce((sum, deck) => sum + getDeckStats(deck).due, 0);
        if (due > 0) {
          new Notice(`EddieCards：今天有 ${due} 张卡片到期。`);
        }
      }
    });

    this.registerView(
      VIEW_TYPE_OB_KI,
      (leaf) => new ObKiDeckView(leaf, this),
    );

    this.addRibbonIcon("layers", "打开 EddieCards 卡组", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-ob-ki-decks",
      name: "打开 EddieCards 卡组界面",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "create-card-from-selection",
      name: "用选中的 Markdown 创建卡片",
      editorCallback: (editor, _view) => this.createCardFromSelection(editor),
    });

    this.addCommand({
      id: "ai-generate-cards-from-current-note",
      name: "AI 从当前笔记生成闪卡",
      callback: () => this.openAiGenerateModal(),
    });

    this.registerDomEvent(window, "keydown", (event: KeyboardEvent) => {
      this.handleCustomHotkey(event);
    }, { capture: true });
  }

  async loadObKiData() {
    const loaded = await this.loadData();
    const settings = {
      ...DEFAULT_SETTINGS,
      ...loaded?.settings,
      createBasicCardHotkey: loaded?.settings?.createBasicCardHotkey
        ?? loaded?.settings?.createCardHotkey
        ?? DEFAULT_SETTINGS.createBasicCardHotkey,
      createExerciseCardHotkey: loaded?.settings?.createExerciseCardHotkey
        ?? DEFAULT_SETTINGS.createExerciseCardHotkey,
      createMicroDeckHotkey: loaded?.settings?.createMicroDeckHotkey
        ?? DEFAULT_SETTINGS.createMicroDeckHotkey,
      showAnswerHotkey: loaded?.settings?.showAnswerHotkey
        ?? DEFAULT_SETTINGS.showAnswerHotkey,
      aiPromptTemplates: loaded?.settings?.aiPromptTemplates?.length
        ? loaded.settings.aiPromptTemplates
        : DEFAULT_SETTINGS.aiPromptTemplates,
      activeAiPromptTemplateId: loaded?.settings?.activeAiPromptTemplateId
        ?? DEFAULT_SETTINGS.activeAiPromptTemplateId,
      gradeHotkeys: {
        ...DEFAULT_SETTINGS.gradeHotkeys,
        ...loaded?.settings?.gradeHotkeys,
      },
    };
    const deckIds = loaded?.deckIds ?? loaded?.decks?.map((deck: ObKiDeck) => deck.id) ?? [];
    const deckPaths = loaded?.deckPaths ?? {};
    const storedDecks = await this.loadDeckFiles(deckIds, deckPaths);

    this.data = {
      ...DEFAULT_DATA,
      decks: storedDecks.length > 0 ? storedDecks : loaded?.decks ?? [],
      activeDeckId: loaded?.activeDeckId,
      deckIds,
      deckPaths,
      deckOrder: loaded?.deckOrder,
      settings,
    };
    normalizeDeckTree(this.data);
    this.settings = this.data.settings ?? DEFAULT_SETTINGS;

    if (this.data.decks.length === 0) {
      const now = Date.now();
      this.data.decks.push({
        id: createId(),
        name: "默认卡组",
        description: "从选中的 Markdown 开始积累你的第一组卡片。",
        createdAt: now,
        updatedAt: now,
        cards: [],
      });
      this.data.activeDeckId = this.data.decks[0].id;
      await this.saveObKiData();
    } else if (storedDecks.length === 0 && loaded?.decks?.length) {
      await this.saveObKiData();
    } else {
      await this.normalizeDeckStorageNames();
    }
  }

  async saveObKiData() {
    this.data.settings = this.settings;
    this.data.deckIds = this.data.decks.map((deck) => deck.id);
    normalizeDeckTree(this.data);
    await this.ensureDataDirs();
    await Promise.all(this.data.decks.map((deck) => this.saveDeckFile(deck)));
    await this.saveData({
      activeDeckId: this.data.activeDeckId,
      deckIds: this.data.deckIds,
      deckPaths: this.data.deckPaths ?? {},
      deckOrder: this.data.deckOrder ?? [],
      settings: this.settings,
    });
    this.refreshViews();
  }

  async saveSettings() {
    this.data.settings = this.settings;
    await this.saveData({
      activeDeckId: this.data.activeDeckId,
      deckIds: this.data.decks.map((deck) => deck.id),
      deckPaths: this.data.deckPaths ?? {},
      deckOrder: this.data.deckOrder ?? [],
      settings: this.settings,
    });
    this.refreshViews();
  }

  async loadDeckFiles(deckIds: string[], deckPaths: Record<string, string>) {
    const decks: ObKiDeck[] = [];
    for (const deckId of deckIds) {
      const candidates = [
        deckPaths[deckId] ? normalizePath(`${this.decksDir}/${deckPaths[deckId]}/data.json`) : "",
        normalizePath(`${this.decksDir}/${deckId}/data.json`),
      ].filter(Boolean);

      const existingPath = await firstExistingPath(this.app, candidates);
      if (existingPath) {
        try {
          decks.push(JSON.parse(await this.app.vault.adapter.read(existingPath)) as ObKiDeck);
        } catch (error) {
          console.error(`Ob Ki failed to read deck ${deckId}`, error);
        }
      }
    }
    return decks;
  }

  async ensureDataDirs() {
    if (!(await this.app.vault.adapter.exists(this.dataDir))) {
      await this.app.vault.adapter.mkdir(this.dataDir);
    }
    if (!(await this.app.vault.adapter.exists(this.decksDir))) {
      await this.app.vault.adapter.mkdir(this.decksDir);
    }
    if (!(await this.app.vault.adapter.exists(this.exportsDir))) {
      await this.app.vault.adapter.mkdir(this.exportsDir);
    }
  }

  async saveDeckFile(deck: ObKiDeck) {
    normalizeDeckStudyOrder(deck);
    this.data.deckPaths = this.data.deckPaths ?? {};
    this.data.deckPaths[deck.id] = this.data.deckPaths[deck.id] ?? this.createReadableDeckDirName(deck);
    const deckDir = this.getDeckDir(deck.id);
    if (!(await this.app.vault.adapter.exists(deckDir))) {
      await this.app.vault.adapter.mkdir(deckDir);
    }
    await this.app.vault.adapter.write(this.getDeckDataPath(deck.id), JSON.stringify(deck, null, 2));
  }

  getDeckDir(deckId: string) {
    const dirName = this.data.deckPaths?.[deckId] ?? deckId;
    return normalizePath(`${this.decksDir}/${dirName}`);
  }

  getDeckDataPath(deckId: string) {
    return normalizePath(`${this.getDeckDir(deckId)}/data.json`);
  }

  createReadableDeckDirName(deck: ObKiDeck) {
    const name = sanitizeFileName(deck.name || "deck").slice(0, 40) || "deck";
    return `${name}-${deck.id.slice(-8)}`;
  }

  async normalizeDeckStorageNames() {
    await this.ensureDataDirs();
    this.data.deckPaths = this.data.deckPaths ?? {};

    for (const deck of this.data.decks) {
      const readableName = this.createReadableDeckDirName(deck);
      const currentName = this.data.deckPaths[deck.id] ?? deck.id;
      if (currentName === readableName) continue;

      const currentDir = normalizePath(`${this.decksDir}/${currentName}`);
      const readableDir = normalizePath(`${this.decksDir}/${readableName}`);
      if (!(await this.app.vault.adapter.exists(readableDir))) {
        await this.app.vault.adapter.mkdir(readableDir);
      }
      await this.app.vault.adapter.write(
        normalizePath(`${readableDir}/data.json`),
        JSON.stringify(deck, null, 2),
      );
      if (await this.app.vault.adapter.exists(currentDir)) {
        await this.app.vault.adapter.rmdir(currentDir, true);
      }
      this.data.deckPaths[deck.id] = readableName;
    }

    await this.saveSettings();
  }

  getDeckSettings(deck?: ObKiDeck) {
    return {
      requestRetention: deck?.settings?.requestRetention ?? this.settings.requestRetention,
      maximumInterval: deck?.settings?.maximumInterval ?? this.settings.maximumInterval,
      dailyNewLimit: deck?.settings?.dailyNewLimit ?? this.settings.dailyNewLimit,
      dailyReviewLimit: deck?.settings?.dailyReviewLimit ?? this.settings.dailyReviewLimit,
      useCustomStudyOrder: deck?.settings?.useCustomStudyOrder ?? true,
    };
  }

  getScheduler(deck?: ObKiDeck) {
    const settings = this.getDeckSettings(deck);
    return fsrs({
      request_retention: settings.requestRetention,
      maximum_interval: settings.maximumInterval,
      enable_fuzz: this.settings.enableFuzz,
      enable_short_term: this.settings.enableShortTerm,
      learning_steps: parseSteps(this.settings.learningSteps, DEFAULT_SETTINGS.learningSteps),
      relearning_steps: parseSteps(this.settings.relearningSteps, DEFAULT_SETTINGS.relearningSteps),
    });
  }

  getDeck(deckId?: string): ObKiDeck | undefined {
    const id = deckId ?? this.data.activeDeckId;
    return this.data.decks.find((deck) => deck.id === id) ?? this.data.decks[0];
  }

  async setActiveDeck(deckId: string) {
    this.data.activeDeckId = deckId;
    await this.saveObKiData();
  }

  async addDeck(name: string, description: string) {
    const now = Date.now();
    const deck: ObKiDeck = {
      id: createId(),
      name: name.trim(),
      description: description.trim(),
      createdAt: now,
      updatedAt: now,
      cards: [],
    };
    this.data.decks.push(deck);
    this.data.activeDeckId = deck.id;
    normalizeDeckTree(this.data);
    this.data.deckOrder?.unshift({ type: "deck", deckId: deck.id });
    await this.saveObKiData();
  }

  async updateDeck(deckId: string, name: string, description: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    deck.name = name.trim();
    deck.description = description.trim();
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async deleteDeck(deckId: string) {
    if (this.data.decks.length <= 1) {
      new Notice("至少保留一个卡组。");
      return;
    }

    this.data.decks = this.data.decks.filter((deck) => deck.id !== deckId);
    this.data.deckOrder = removeDeckFromTree(this.data.deckOrder ?? [], deckId);
    const deckDir = this.getDeckDir(deckId);
    if (await this.app.vault.adapter.exists(deckDir)) {
      await this.app.vault.adapter.rmdir(deckDir, true);
    }
    delete this.data.deckPaths?.[deckId];
    if (this.data.activeDeckId === deckId) {
      this.data.activeDeckId = this.data.decks[0]?.id;
    }
    await this.saveObKiData();
  }

  async createDeckFolder(parentFolderId?: string) {
    normalizeDeckTree(this.data);
    const folder: ObKiDeckFolder = { id: createId(), name: "新文件夹", items: [] };
    const parent = parentFolderId ? findDeckFolderInItems(this.data.deckOrder ?? [], parentFolderId) : undefined;
    if (parent) {
      parent.items.unshift({ type: "folder", folder });
    } else {
      this.data.deckOrder?.unshift({ type: "folder", folder });
    }
    await this.saveObKiData();
  }

  async renameDeckFolder(folderId: string, name: string) {
    normalizeDeckTree(this.data);
    const nextName = name.trim();
    if (!nextName || !findDeckFolderInItems(this.data.deckOrder ?? [], folderId)) return;
    this.data.deckOrder = renameDeckFolderInItems(this.data.deckOrder ?? [], folderId, nextName);
    await this.saveObKiData();
  }

  async dissolveDeckFolder(folderId: string) {
    normalizeDeckTree(this.data);
    const parentItems = findParentItemsForDeckFolder(this.data.deckOrder ?? [], folderId) ?? this.data.deckOrder;
    if (!parentItems) return;
    const index = parentItems.findIndex((item) => item.type === "folder" && item.folder.id === folderId);
    if (index < 0) return;
    const item = parentItems[index];
    if (item?.type !== "folder") return;
    parentItems.splice(index, 1, ...item.folder.items);
    await this.saveObKiData();
  }

  async deleteDeckFolder(folderId: string) {
    normalizeDeckTree(this.data);
    this.data.deckOrder = deleteDeckFolderById(this.data.deckOrder ?? [], folderId);
    await this.saveObKiData();
  }

  async moveDeckToFolder(deckId: string, targetFolderId?: string) {
    normalizeDeckTree(this.data);
    this.data.deckOrder = removeDeckFromTree(this.data.deckOrder ?? [], deckId);
    const target = targetFolderId ? findDeckFolderInItems(this.data.deckOrder ?? [], targetFolderId) : undefined;
    const item: ObKiDeckTreeItem = { type: "deck", deckId };
    if (target) {
      target.items.unshift(item);
    } else {
      this.data.deckOrder?.unshift(item);
    }
    await this.saveObKiData();
  }

  async moveDeckFolderToFolder(folderId: string, targetFolderId?: string) {
    normalizeDeckTree(this.data);
    const sourceItems = findParentItemsForDeckFolder(this.data.deckOrder ?? [], folderId) ?? this.data.deckOrder;
    if (!sourceItems) return;
    const sourceIndex = sourceItems.findIndex((item) => item.type === "folder" && item.folder.id === folderId);
    if (sourceIndex < 0) return;
    const [item] = sourceItems.splice(sourceIndex, 1);
    if (!item || item.type !== "folder") return;
    if (targetFolderId && deckFolderContainsFolder(item.folder, targetFolderId)) {
      sourceItems.splice(sourceIndex, 0, item);
      return;
    }
    const target = targetFolderId ? findDeckFolderInItems(this.data.deckOrder ?? [], targetFolderId) : undefined;
    if (target) {
      target.items.unshift(item);
    } else {
      this.data.deckOrder?.unshift(item);
    }
    await this.saveObKiData();
  }

  async addCard(deckId: string, front: string, back: string, sourceFile?: TFile | null, type: CardType = "basic", sourceLine?: number, microDeckId?: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return undefined;

    const now = Date.now();
    const fsrsCard = createEmptyCard(new Date(now));
    normalizeDeckStudyOrder(deck);
    const card: ObKiCard = {
      id: createId(),
      type,
      front: front.trim(),
      back: back.trim(),
      sourcePath: sourceFile?.path,
      sourceLink: sourceFile ? pathToWikiLink(sourceFile.path) : undefined,
      sourceLine,
      createdAt: now,
      updatedAt: now,
      ...fromFsrsCard(fsrsCard),
    };
    deck.cards.unshift(card);
    const orderItem: ObKiMicroDeckItem = { type: "card", cardId: card.id };
    const microDeck = microDeckId ? findMicroDeckInItems(deck.studyOrder ?? [], microDeckId) : undefined;
    if (microDeck) {
      microDeck.items.push(orderItem);
    } else {
      deck.studyOrder?.push(orderItem);
    }
    deck.updatedAt = now;
    await this.saveObKiData();
    return card.id;
  }

  async deleteCard(deckId: string, cardId: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    deck.cards = deck.cards.filter((card) => card.id !== cardId);
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async updateCard(deckId: string, cardId: string, updates: Pick<ObKiCard, "front" | "back" | "type"> & { sourceLink?: string }) {
    const deck = this.getDeck(deckId);
    const card = deck?.cards.find((item) => item.id === cardId);
    if (!deck || !card) return;

    Object.assign(card, {
      front: updates.front.trim(),
      back: updates.back.trim(),
      type: updates.type,
      sourceLink: updates.sourceLink?.trim() || card.sourceLink,
      updatedAt: Date.now(),
    });
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async setCardSuspended(deckId: string, cardId: string, suspended: boolean) {
    const deck = this.getDeck(deckId);
    const card = deck?.cards.find((item) => item.id === cardId);
    if (!deck || !card) return;
    card.suspended = suspended;
    card.updatedAt = Date.now();
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async setCardsSuspended(deckId: string, cardIds: string[], suspended: boolean) {
    const deck = this.getDeck(deckId);
    if (!deck || cardIds.length === 0) return;
    const idSet = new Set(cardIds);
    const now = Date.now();
    deck.cards.forEach((card) => {
      if (!idSet.has(card.id)) return;
      card.suspended = suspended;
      card.updatedAt = now;
    });
    deck.updatedAt = now;
    await this.saveObKiData();
  }

  async updateDeckSettings(deckId: string, settings: ObKiDeckSettings) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    deck.settings = {
      ...deck.settings,
      ...settings,
    };
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async moveCards(cardIds: string[], fromDeckId: string, toDeckId: string, targetMicroDeckId?: string) {
    if (cardIds.length === 0) return;
    const fromDeck = this.getDeck(fromDeckId);
    const toDeck = this.getDeck(toDeckId);
    if (!fromDeck || !toDeck) return;
    if (fromDeckId === toDeckId && !targetMicroDeckId) return;

    const moving = fromDeck.cards.filter((card) => cardIds.includes(card.id));
    if (moving.length === 0) return;

    normalizeDeckStudyOrder(fromDeck);
    if (fromDeckId !== toDeckId) normalizeDeckStudyOrder(toDeck);

    fromDeck.studyOrder = removeCardsFromOrder(fromDeck.studyOrder ?? [], cardIds);
    if (fromDeckId !== toDeckId) {
      const movingLogs = (fromDeck.reviewLog ?? []).filter((log) => cardIds.includes(log.cardId));
      fromDeck.cards = fromDeck.cards.filter((card) => !cardIds.includes(card.id));
      fromDeck.reviewLog = (fromDeck.reviewLog ?? []).filter((log) => !cardIds.includes(log.cardId));
      toDeck.cards.unshift(...moving);
      toDeck.reviewLog = [...movingLogs, ...(toDeck.reviewLog ?? [])];
    } else {
      toDeck.studyOrder = removeCardsFromOrder(toDeck.studyOrder ?? [], cardIds);
    }

    const targetItems = moving.map((card): ObKiMicroDeckItem => ({ type: "card", cardId: card.id }));
    const targetMicroDeck = targetMicroDeckId ? findMicroDeckInItems(toDeck.studyOrder ?? [], targetMicroDeckId) : undefined;
    if (targetMicroDeck) {
      targetMicroDeck.items.push(...targetItems);
    } else {
      toDeck.studyOrder?.push(...targetItems);
    }

    const now = Date.now();
    fromDeck.updatedAt = now;
    toDeck.updatedAt = now;
    await this.saveObKiData();
  }

  async resetCards(deckId: string, cardIds: string[]) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    const now = Date.now();
    deck.cards.forEach((card) => {
      if (!cardIds.includes(card.id)) return;
      Object.assign(card, fromFsrsCard(createEmptyCard(new Date(now))), {
        updatedAt: now,
      });
    });
    deck.reviewLog = (deck.reviewLog ?? []).filter((log) => !cardIds.includes(log.cardId));
    deck.updatedAt = now;
    await this.saveObKiData();
  }

  async deleteCards(deckId: string, cardIds: string[]) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    deck.cards = deck.cards.filter((card) => !cardIds.includes(card.id));
    deck.reviewLog = (deck.reviewLog ?? []).filter((log) => !cardIds.includes(log.cardId));
    deck.microDecks = removeCardsFromMicroDecks(deck.microDecks ?? [], cardIds);
    if (deck.studyOrder) {
      deck.studyOrder = removeCardsFromOrder(deck.studyOrder, cardIds);
    }
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async createMicroDeck(deckId: string, name: string, cardIds: string[], parentMicroDeckId?: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    normalizeDeckStudyOrder(deck);
    const insertion = findFirstCardInsertion(deck.studyOrder ?? [], cardIds, parentMicroDeckId);
    deck.studyOrder = removeCardsFromOrder(deck.studyOrder ?? [], cardIds);
    const microDeck: ObKiMicroDeck = {
      id: createId(),
      name: name.trim() || "未命名微卡组",
      items: cardIds.map((cardId) => ({ type: "card", cardId })),
    };

    if (parentMicroDeckId) {
      const parent = findMicroDeckInItems(deck.studyOrder ?? [], parentMicroDeckId);
      if (parent) {
        const index = insertion?.parentMicroDeckId === parentMicroDeckId ? Math.min(insertion.index, parent.items.length) : parent.items.length;
        parent.items.splice(index, 0, { type: "microDeck", microDeck });
      } else {
        deck.studyOrder?.push({ type: "microDeck", microDeck });
      }
    } else {
      const index = insertion && !insertion.parentMicroDeckId ? Math.min(insertion.index, deck.studyOrder?.length ?? 0) : deck.studyOrder?.length ?? 0;
      deck.studyOrder?.splice(index, 0, { type: "microDeck", microDeck });
    }

    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async createEmptyMicroDeck(deckId: string, name: string, parentMicroDeckId?: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return undefined;
    normalizeDeckStudyOrder(deck);
    const microDeck: ObKiMicroDeck = {
      id: createId(),
      name: name.trim() || "新微卡组",
      items: [],
    };
    if (parentMicroDeckId) {
      const parent = findMicroDeckInItems(deck.studyOrder ?? [], parentMicroDeckId);
      if (parent) {
        parent.items.push({ type: "microDeck", microDeck });
      } else {
        deck.studyOrder?.push({ type: "microDeck", microDeck });
      }
    } else {
      deck.studyOrder?.push({ type: "microDeck", microDeck });
    }
    deck.updatedAt = Date.now();
    await this.saveObKiData();
    return microDeck.id;
  }

  async createChildMicroDeck(deckId: string, parentMicroDeckId: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return undefined;
    normalizeDeckStudyOrder(deck);
    const parent = findMicroDeckInItems(deck.studyOrder ?? [], parentMicroDeckId);
    if (!parent) return undefined;
    const microDeck: ObKiMicroDeck = {
      id: createId(),
      name: "子微卡组",
      items: [],
    };
    parent.items.push({
      type: "microDeck",
      microDeck,
    });
    deck.updatedAt = Date.now();
    await this.saveObKiData();
    return microDeck.id;
  }

  async renameMicroDeck(deckId: string, microDeckId: string, name: string) {
    const deck = this.getDeck(deckId);
    normalizeDeckStudyOrder(deck);
    const microDeck = deck ? findMicroDeckInItems(deck.studyOrder ?? [], microDeckId) : undefined;
    if (!deck || !microDeck) return;
    microDeck.name = name.trim() || microDeck.name;
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async deleteMicroDeck(deckId: string, microDeckId: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    normalizeDeckStudyOrder(deck);
    deck.studyOrder = deleteMicroDeckByIdInItems(deck.studyOrder ?? [], microDeckId);
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async reorderMicroDeckItem(deckId: string, microDeckId: string, fromIndex: number, toIndex: number) {
    const deck = this.getDeck(deckId);
    normalizeDeckStudyOrder(deck);
    const microDeck = deck ? findMicroDeckInItems(deck.studyOrder ?? [], microDeckId) : undefined;
    if (!deck || !microDeck) return;
    const [item] = microDeck.items.splice(fromIndex, 1);
    if (!item) return;
    microDeck.items.splice(toIndex, 0, item);
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async reorderStudyOrderItem(deckId: string, parentMicroDeckId: string | undefined, fromIndex: number, toIndex: number) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    normalizeDeckStudyOrder(deck);
    const items = parentMicroDeckId
      ? findMicroDeckInItems(deck.studyOrder ?? [], parentMicroDeckId)?.items
      : deck.studyOrder;
    if (!items) return;
    const [item] = items.splice(fromIndex, 1);
    if (!item) return;
    items.splice(toIndex, 0, item);
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async moveStudyOrderItemToMicroDeck(deckId: string, sourceParentMicroDeckId: string | undefined, sourceIndex: number, targetMicroDeckId: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    normalizeDeckStudyOrder(deck);
    const sourceItems = sourceParentMicroDeckId
      ? findMicroDeckInItems(deck.studyOrder ?? [], sourceParentMicroDeckId)?.items
      : deck.studyOrder;
    const target = findMicroDeckInItems(deck.studyOrder ?? [], targetMicroDeckId);
    if (!sourceItems || !target) return;

    const [item] = sourceItems.splice(sourceIndex, 1);
    if (!item) return;
    if (item.type === "microDeck" && (item.microDeck.id === targetMicroDeckId || microDeckContainsMicroDeck(item.microDeck, targetMicroDeckId))) {
      sourceItems.splice(sourceIndex, 0, item);
      return;
    }

    target.items.push(item);
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async moveItemOutOfMicroDeck(deckId: string, parentMicroDeckId: string, itemIndex: number) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    normalizeDeckStudyOrder(deck);
    const parent = findMicroDeckInItems(deck.studyOrder ?? [], parentMicroDeckId);
    if (!parent) return;
    const [item] = parent.items.splice(itemIndex, 1);
    if (!item) return;
    const target = findParentItemsForMicroDeck(deck.studyOrder ?? [], parentMicroDeckId) ?? deck.studyOrder;
    const parentItemIndex = target?.findIndex((candidate) => (
      candidate.type === "microDeck" && candidate.microDeck.id === parentMicroDeckId
    )) ?? -1;
    target?.splice(parentItemIndex >= 0 ? parentItemIndex + 1 : target.length, 0, item);
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async moveMicroDeckToParent(deckId: string, microDeckId: string, targetParentMicroDeckId?: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    normalizeDeckStudyOrder(deck);
    const sourceItems = findParentItemsForMicroDeck(deck.studyOrder ?? [], microDeckId) ?? deck.studyOrder;
    if (!sourceItems) return;
    const sourceIndex = sourceItems.findIndex((item) => item.type === "microDeck" && item.microDeck.id === microDeckId);
    if (sourceIndex < 0) return;
    const [item] = sourceItems.splice(sourceIndex, 1);
    if (!item || item.type !== "microDeck") return;

    if (targetParentMicroDeckId) {
      const target = findMicroDeckInItems(deck.studyOrder ?? [], targetParentMicroDeckId);
      if (!target || microDeckContainsMicroDeck(item.microDeck, targetParentMicroDeckId)) {
        sourceItems.splice(sourceIndex, 0, item);
        return;
      }
      target.items.push(item);
    } else {
      deck.studyOrder?.push(item);
    }

    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async moveMicroDeckToDeck(fromDeckId: string, microDeckId: string, toDeckId: string, targetParentMicroDeckId?: string) {
    const fromDeck = this.getDeck(fromDeckId);
    const toDeck = this.getDeck(toDeckId);
    if (!fromDeck || !toDeck) return;
    normalizeDeckStudyOrder(fromDeck);
    if (fromDeckId !== toDeckId) normalizeDeckStudyOrder(toDeck);

    const sourceItems = findParentItemsForMicroDeck(fromDeck.studyOrder ?? [], microDeckId) ?? fromDeck.studyOrder;
    if (!sourceItems) return;
    const sourceIndex = sourceItems.findIndex((item) => item.type === "microDeck" && item.microDeck.id === microDeckId);
    if (sourceIndex < 0) return;
    const [item] = sourceItems.splice(sourceIndex, 1);
    if (!item || item.type !== "microDeck") return;

    if (fromDeckId === toDeckId && targetParentMicroDeckId && microDeckContainsMicroDeck(item.microDeck, targetParentMicroDeckId)) {
      sourceItems.splice(sourceIndex, 0, item);
      return;
    }

    if (fromDeckId !== toDeckId) {
      const cardIds = getMicroDeckCardIds(item.microDeck);
      const movingCards = fromDeck.cards.filter((card) => cardIds.includes(card.id));
      const movingLogs = (fromDeck.reviewLog ?? []).filter((log) => cardIds.includes(log.cardId));
      fromDeck.cards = fromDeck.cards.filter((card) => !cardIds.includes(card.id));
      fromDeck.reviewLog = (fromDeck.reviewLog ?? []).filter((log) => !cardIds.includes(log.cardId));
      toDeck.cards.unshift(...movingCards);
      toDeck.reviewLog = [...movingLogs, ...(toDeck.reviewLog ?? [])];
    }

    const targetMicroDeck = targetParentMicroDeckId ? findMicroDeckInItems(toDeck.studyOrder ?? [], targetParentMicroDeckId) : undefined;
    if (targetMicroDeck) {
      targetMicroDeck.items.push(item);
    } else {
      toDeck.studyOrder?.push(item);
    }

    const now = Date.now();
    fromDeck.updatedAt = now;
    toDeck.updatedAt = now;
    await this.saveObKiData();
  }

  async dissolveMicroDeck(deckId: string, microDeckId: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    normalizeDeckStudyOrder(deck);
    const parentItems = findParentItemsForMicroDeck(deck.studyOrder ?? [], microDeckId) ?? deck.studyOrder;
    if (!parentItems) return;
    const index = parentItems.findIndex((item) => item.type === "microDeck" && item.microDeck.id === microDeckId);
    if (index < 0) return;
    const item = parentItems[index];
    if (item?.type !== "microDeck") return;
    parentItems.splice(index, 1, ...item.microDeck.items);
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async addCardsToMicroDeck(deckId: string, microDeckId: string, cardIds: string[]) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    normalizeDeckStudyOrder(deck);
    deck.studyOrder = removeCardsFromOrder(deck.studyOrder ?? [], cardIds);
    const microDeck = findMicroDeckInItems(deck.studyOrder ?? [], microDeckId);
    if (!microDeck) return;
    microDeck.items.push(...cardIds.map((cardId): ObKiMicroDeckItem => ({ type: "card", cardId })));
    deck.updatedAt = Date.now();
    await this.saveObKiData();
  }

  async gradeCard(deckId: string, cardId: string, grade: ReviewGrade) {
    const deck = this.getDeck(deckId);
    const card = deck?.cards.find((item) => item.id === cardId);
    if (!deck || !card) return;

    const now = Date.now();
    const before = structuredClone(card);
    const wasNew = card.reviews === 0;
    const result = this.getScheduler(deck).next(toFsrsCard(card), new Date(now), toFsrsRating(grade));
    if (grade === "again" && hasImmediateAgainStep(this.settings.learningSteps)) {
      result.card.due = new Date(now);
      result.card.scheduled_days = 0;
    }
    Object.assign(card, fromFsrsCard(result.card), {
      updatedAt: now,
    });
    const log: ObKiReviewLog = {
      id: createId(),
      cardId,
      grade,
      reviewedAt: now,
      wasNew,
    };
    deck.reviewLog = [...(deck.reviewLog ?? []), log];
    this.lastUndo = { deckId, card: before, loggedReviewId: log.id };
    deck.updatedAt = now;
    await this.saveObKiData();
  }

  async undoLastReview() {
    if (!this.lastUndo) {
      new Notice("没有可撤销的复习。");
      return;
    }

    const deck = this.getDeck(this.lastUndo.deckId);
    const index = deck?.cards.findIndex((card) => card.id === this.lastUndo?.card.id) ?? -1;
    if (!deck || index < 0) {
      new Notice("找不到要撤销的卡片。");
      return;
    }

    deck.cards[index] = this.lastUndo.card;
    deck.reviewLog = (deck.reviewLog ?? []).filter((log) => log.id !== this.lastUndo?.loggedReviewId);
    deck.updatedAt = Date.now();
    this.lastUndo = undefined;
    await this.saveObKiData();
    new Notice("已撤销最近一次评分。");
  }

  async openCardSource(card: ObKiCard) {
    const sourceLink = card.sourceLink || (card.sourcePath ? pathToWikiLink(card.sourcePath) : "");
    if (!sourceLink) {
      new Notice("这张卡没有来源文件。");
      return;
    }

    const linkText = wikiLinkToLinkText(sourceLink);
    const file = this.app.metadataCache.getFirstLinkpathDest(linkText, card.sourcePath ?? "");
    if (!(file instanceof TFile)) {
      new Notice("来源不存在。");
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true });
  }

  async exportDeckToAnki(deckId: string) {
    const deck = this.getDeck(deckId);
    if (!deck) return;
    if (deck.cards.length === 0) {
      new Notice("这个卡组还没有卡片，无法导出。");
      return;
    }

    try {
      await this.ensureDataDirs();
      const Exporter = require("anki-apkg-export/dist/exporter").default;
      const template = require("anki-apkg-export/dist/template").default;
      const sql = require("sql.js");
      const apkg = new Exporter(deck.name, { template: template(), sql });

      const media = new AnkiMediaProcessor(this.app, apkg);
      for (const card of deck.cards) {
        apkg.addCard(await markdownToAnkiHtml(card.front, media, card.sourcePath), await markdownToAnkiHtml(card.back, media, card.sourcePath), {
          tags: ["Ob_Ki", card.type === "exercise" ? "Exercise" : "Basic"],
        });
      }

      const exported = await apkg.save({ type: "arraybuffer", compression: "DEFLATE" });
      const buffer = exported instanceof ArrayBuffer
        ? exported
        : await exported.arrayBuffer();
      const fileName = `${sanitizeFileName(deck.name || "deck") || "deck"}-${formatExportTimestamp(new Date())}.apkg`;
      const outputPath = normalizePath(`${this.exportsDir}/${fileName}`);
      await this.app.vault.adapter.writeBinary(outputPath, buffer);
      new Notice(`Anki 牌组已导出：${outputPath}`);
    } catch (error) {
      console.error("Ob Ki export failed", error);
      new Notice("导出 Anki 牌组失败，请查看开发者控制台。");
    }
  }

  async exportBackup() {
    try {
      await this.ensureDataDirs();
      const backup: ObKiBackupFile = {
        app: "EddieCards",
        version: 1,
        exportedAt: Date.now(),
        data: {
          decks: this.data.decks,
          activeDeckId: this.data.activeDeckId,
          deckIds: this.data.decks.map((deck) => deck.id),
          deckPaths: this.data.deckPaths ?? {},
          deckOrder: this.data.deckOrder ?? [],
          settings: this.settings,
        },
      };
      const fileName = `EddieCards-backup-${formatExportTimestamp(new Date())}.json`;
      const outputPath = normalizePath(`${this.exportsDir}/${fileName}`);
      await this.app.vault.adapter.write(outputPath, JSON.stringify(backup, null, 2));
      new Notice(`EddieCards 备份已导出：${outputPath}`);
    } catch (error) {
      console.error("EddieCards backup export failed", error);
      new Notice("导出备份失败，请查看控制台。");
    }
  }

  async importBackupFromText(text: string) {
    let backup: ObKiBackupFile;
    try {
      backup = JSON.parse(text) as ObKiBackupFile;
    } catch {
      new Notice("备份文件不是有效 JSON。");
      return;
    }

    if (backup.app !== "EddieCards" || backup.version !== 1 || !Array.isArray(backup.data?.decks)) {
      new Notice("这不是有效的 EddieCards 备份文件。");
      return;
    }

    if (!window.confirm("恢复备份会覆盖当前 EddieCards 数据。确定继续？")) return;

    this.data = {
      decks: backup.data.decks,
      activeDeckId: backup.data.activeDeckId ?? backup.data.decks[0]?.id,
      deckIds: backup.data.decks.map((deck) => deck.id),
      deckPaths: backup.data.deckPaths ?? {},
      deckOrder: backup.data.deckOrder,
      settings: {
        ...DEFAULT_SETTINGS,
        ...(backup.data.settings ?? {}),
        gradeHotkeys: {
          ...DEFAULT_SETTINGS.gradeHotkeys,
          ...(backup.data.settings?.gradeHotkeys ?? {}),
        },
      },
    };
    this.settings = this.data.settings ?? DEFAULT_SETTINGS;
    normalizeDeckTree(this.data);

    await this.ensureDataDirs();
    if (await this.app.vault.adapter.exists(this.decksDir)) {
      await this.app.vault.adapter.rmdir(this.decksDir, true);
    }
    await this.ensureDataDirs();
    await this.normalizeDeckStorageNames();
    await this.saveObKiData();
    new Notice("EddieCards 备份已恢复。");
  }

  importBackupFromPicker() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      await this.importBackupFromText(await file.text());
    };
    input.click();
  }

  async scanHealth(): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const deck of this.data.decks) {
      for (const card of deck.cards) {
        if ((card.sourceLink || card.sourcePath) && !this.resolveCardSourceFile(card)) {
          issues.push(createHealthIssue("source-missing", deck, card, "来源", card.sourceLink || card.sourcePath || ""));
        }
        this.scanCardMarkdownHealth(deck, card, "正面", card.front, issues);
        this.scanCardMarkdownHealth(deck, card, "背面", card.back, issues);
      }
    }
    return issues;
  }

  private scanCardMarkdownHealth(deck: ObKiDeck, card: ObKiCard, field: "正面" | "背面", markdown: string, issues: HealthIssue[]) {
    const sourcePath = card.sourcePath ?? "";
    for (const image of extractMarkdownImages(markdown)) {
      if (!isExternalUrl(image) && !this.resolveLinkFile(image, sourcePath)) {
        issues.push(createHealthIssue("image-missing", deck, card, field, image));
      }
    }
    for (const link of extractWikiLinks(markdown)) {
      if (!this.resolveLinkFile(link, sourcePath)) {
        issues.push(createHealthIssue("wiki-missing", deck, card, field, link));
      }
    }
  }

  private resolveCardSourceFile(card: ObKiCard) {
    const sourceLink = card.sourceLink || (card.sourcePath ? pathToWikiLink(card.sourcePath) : "");
    if (!sourceLink) return undefined;
    return this.resolveLinkFile(wikiLinkToLinkText(sourceLink), card.sourcePath ?? "");
  }

  private resolveLinkFile(linkText: string, sourcePath: string) {
    const normalized = stripLinkAliasAndAnchor(linkText);
    return this.app.metadataCache.getFirstLinkpathDest(normalized, sourcePath);
  }

  openAiGenerateModal() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("请先打开一篇笔记。");
      return;
    }
    new AiGenerateCardsModal(this.app, this, file).open();
  }

  async generateCardsWithAi(
    deckId: string,
    sourceFile: TFile,
    prompt: string,
    cardType: CardType,
    limit: number,
    onProgress?: (message: string) => void,
  ) {
    const cards = await this.previewCardsWithAi(sourceFile, prompt, cardType, limit, onProgress);
    onProgress?.(`开始写入 ${cards.length} 张卡片...`);
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      await this.addCard(deckId, card.front, card.back, sourceFile, card.type ?? cardType);
      onProgress?.(`已添加 ${index + 1}/${cards.length}: ${card.front.slice(0, 28)}`);
    }
    onProgress?.("完成。");
    return cards.length;
  }

  async previewCardsWithAi(
    sourceFile: TFile,
    prompt: string,
    cardType: CardType,
    limit: number,
    onProgress?: (message: string) => void,
  ) {
    if (!this.settings.aiApiKey.trim()) {
      new Notice("请先在 EddieCards 设置里填写 AI API Key。");
      return [];
    }

    onProgress?.("读取当前笔记...");
    const note = await this.app.vault.read(sourceFile);
    onProgress?.(`笔记读取完成，共 ${note.length} 个字符。`);
    onProgress?.(`请求模型 ${this.settings.aiModel}...`);
    const cards = await requestAiCards(this.settings, note, prompt, cardType, limit, onProgress);
    onProgress?.(`模型返回 ${cards.length} 张可用卡片。`);
    return cards;
  }

  async refreshAiModels() {
    if (!this.settings.aiApiKey.trim()) {
      new Notice("请先填写 AI API Key。");
      return;
    }

    const models: string[] = await requestAiModels(this.settings);
    this.settings.aiModelOptions = models;
    if (models.length > 0 && !models.includes(this.settings.aiModel)) {
      this.settings.aiModel = models[0];
    }
    await this.saveSettings();
    new Notice(`检测到 ${models.length} 个模型。`);
  }

  async createCardFromSelection(editor: Editor, cardType: CardType = "basic") {
    const selection = editor.getSelection().trim();
    if (!selection) {
      new Notice("请先选中一段 Markdown 文本作为卡片背面。");
      return;
    }

    const sourceFile = this.app.workspace.getActiveFile();
    const sourceLine = Math.min(...editor.listSelections().map((selectionRange) => (
      Math.min(selectionRange.anchor.line, selectionRange.head.line)
    )));
    new AddCardModal(this.app, this, selection, sourceFile, cardType, sourceLine).open();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_OB_KI)[0] ?? null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("无法创建 EddieCards 视图。");
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE_OB_KI, active: true });
    }

    workspace.revealLeaf(leaf);
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_OB_KI).forEach((leaf) => {
      if (leaf.view instanceof ObKiDeckView) {
        leaf.view.configureRefreshTimer();
        leaf.view.render();
      }
    });
  }

  private async handleCustomHotkey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    const tagName = target?.tagName.toLowerCase();
    if (tagName === "input" || tagName === "textarea" || tagName === "select") return;

    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf?.view instanceof ObKiDeckView && await activeLeaf.view.handleGradeHotkey(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const cardType = matchesShortcut(event, this.settings.createBasicCardHotkey)
      ? "basic"
      : matchesShortcut(event, this.settings.createExerciseCardHotkey)
        ? "exercise"
        : null;
    if (!cardType) return;

    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!markdownView) return;

    event.preventDefault();
    event.stopPropagation();
    await this.createCardFromSelection(markdownView.editor, cardType);
  }
}

class ObKiSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ObKiPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ob-ki-settings");

    containerEl.createEl("h2", { text: "EddieCards 设置" });

    this.renderCreateHotkeySetting(containerEl, "基础卡制卡快捷键", "createBasicCardHotkey");
    this.renderCreateHotkeySetting(containerEl, "习题卡制卡快捷键", "createExerciseCardHotkey");
    this.renderCreateHotkeySetting(containerEl, "组成微卡组快捷键", "createMicroDeckHotkey");
    this.renderCreateHotkeySetting(containerEl, "显示答案快捷键", "showAnswerHotkey");

    containerEl.createEl("h3", { text: "复习快捷键" });
    this.renderHotkeySetting(containerEl, "重来", "again");
    this.renderHotkeySetting(containerEl, "困难", "hard");
    this.renderHotkeySetting(containerEl, "良好", "good");
    this.renderHotkeySetting(containerEl, "简单", "easy");

    new Setting(containerEl)
      .setName("添加卡片后打开卡组界面")
      .setDesc("关闭后，快捷制卡只弹出添加窗口，不会切到 EddieCards 视图。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.openViewAfterAdd);
        toggle.onChange(async (value) => {
          this.plugin.settings.openViewAfterAdd = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("快捷制卡默认卡组")
      .setDesc("控制添加窗口打开时默认选中的卡组。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("active", "当前选中卡组")
          .addOption("first", "第一个卡组")
          .setValue(this.plugin.settings.defaultDeckMode)
          .onChange(async (value: ObKiSettings["defaultDeckMode"]) => {
            this.plugin.settings.defaultDeckMode = value;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "FSRS 调度" });

    new Setting(containerEl)
      .setName("目标记忆保持率")
      .setDesc("Anki/FSRS 常用默认值是 90%。越高复习越频繁。")
      .addSlider((slider) => {
        slider
          .setLimits(70, 97, 1)
          .setValue(Math.round(this.plugin.settings.requestRetention * 100))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.requestRetention = value / 100;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("最大间隔天数")
      .setDesc("限制卡片最多能被安排到未来多少天。")
      .addText((text) => {
        text
          .setPlaceholder("36500")
          .setValue(String(this.plugin.settings.maximumInterval))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 1) {
              this.plugin.settings.maximumInterval = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("启用间隔扰动")
      .setDesc("给较长间隔加少量随机扰动，避免大量卡片同一天集中到期。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableFuzz);
        toggle.onChange(async (value) => {
          this.plugin.settings.enableFuzz = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("启用短期学习步长")
      .setDesc("控制新卡和重学卡在分钟级别的短期复习。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableShortTerm);
        toggle.onChange(async (value) => {
          this.plugin.settings.enableShortTerm = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("学习步长")
      .setDesc("逗号分隔，例如：1m, 10m。支持 m/h/d。")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.learningSteps)
          .onChange(async (value) => {
            this.plugin.settings.learningSteps = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("重新学习步长")
      .setDesc("答错复习卡后进入的短期步长，例如：10m。")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.relearningSteps)
          .onChange(async (value) => {
            this.plugin.settings.relearningSteps = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("每日新卡上限")
      .setDesc("普通复习中每天最多学习多少张新卡。设为 0 表示不限制。")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.dailyNewLimit))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 0) {
              this.plugin.settings.dailyNewLimit = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("每日复习上限")
      .setDesc("普通复习中每天最多复习多少张非新卡。设为 0 表示不限制。")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.dailyReviewLimit))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 0) {
              this.plugin.settings.dailyReviewLimit = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    containerEl.createEl("h3", { text: "AI 制卡" });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("兼容 OpenAI Chat Completions 的接口地址。")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.aiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.aiBaseUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("仅保存在本地 Obsidian 插件数据中。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.aiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.aiApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("模型")
      .setDesc("点击检测后，会根据当前 Base URL 和 API Key 拉取模型列表。")
      .addDropdown((dropdown) => {
        const options = this.plugin.settings.aiModelOptions.length > 0
          ? this.plugin.settings.aiModelOptions
          : [this.plugin.settings.aiModel || DEFAULT_SETTINGS.aiModel];
        options.forEach((model) => dropdown.addOption(model, model));
        if (!options.includes(this.plugin.settings.aiModel)) {
          dropdown.addOption(this.plugin.settings.aiModel, this.plugin.settings.aiModel);
        }
        dropdown
          .setValue(this.plugin.settings.aiModel)
          .onChange(async (value) => {
            this.plugin.settings.aiModel = value;
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) => {
        button.setButtonText("检测模型").onClick(async () => {
          try {
            await this.plugin.refreshAiModels();
            this.display();
          } catch (error) {
            console.error("EddieCards model detection failed", error);
            new Notice("模型检测失败，请检查 Base URL、API Key 或控制台错误。");
          }
        });
      });

    new Setting(containerEl)
      .setName("手动模型名")
      .setDesc("如果接口不支持 /models，或模型没有出现在检测结果里，可以手动填写。")
      .addText((text) => {
        text
          .setPlaceholder("your-model-name")
          .setValue(this.plugin.settings.aiModel)
          .onChange(async (value) => {
            if (!value.trim()) return;
            this.plugin.settings.aiModel = value.trim();
            await this.plugin.saveSettings();
          });
      });

    this.renderAiPromptTemplateSettings(containerEl);

    containerEl.createEl("h3", { text: "界面" });

    new Setting(containerEl)
      .setName("卡组界面自动刷新")
      .setDesc("单位：秒。设为 0 可关闭自动刷新。")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.autoRefreshSeconds))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 0) {
              this.plugin.settings.autoRefreshSeconds = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("启动时提醒今日到期")
      .setDesc("打开 Obsidian 后，如果有到期卡片，会弹出提醒。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableReviewReminder)
          .onChange(async (value) => {
            this.plugin.settings.enableReviewReminder = value;
            await this.plugin.saveSettings();
          });
      });
  }

  private renderAiPromptTemplateSettings(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "AI 提示词模板" });
    let template = getActivePromptTemplate(this.plugin.settings);
    if (!template) {
      template = {
        id: createId(),
        name: "默认模板",
        prompt: "请根据当前笔记生成闪卡。",
      };
      this.plugin.settings.aiPromptTemplates.push(template);
      this.plugin.settings.activeAiPromptTemplateId = template.id;
    }

    new Setting(containerEl)
      .setName("选择模板")
      .setDesc("选择一个模板进行编辑。")
      .addDropdown((dropdown) => {
        this.plugin.settings.aiPromptTemplates.forEach((item) => {
          dropdown.addOption(item.id, item.name);
        });
        dropdown
          .setValue(template.id)
          .onChange(async (value) => {
            this.plugin.settings.activeAiPromptTemplateId = value;
            await this.plugin.saveSettings();
            this.display();
          });
      })
      .addButton((button) => {
        button.setButtonText("新增").setCta().onClick(async () => {
          const id = createId();
          this.plugin.settings.aiPromptTemplates.push({
            id,
            name: "新模板",
            prompt: "请根据当前笔记生成闪卡。",
          });
          this.plugin.settings.activeAiPromptTemplateId = id;
          await this.plugin.saveSettings();
          this.display();
        });
      })
      .addButton((button) => {
        button
          .setButtonText("删除当前")
          .setDisabled(this.plugin.settings.aiPromptTemplates.length <= 1)
          .onClick(async () => {
            this.plugin.settings.aiPromptTemplates = this.plugin.settings.aiPromptTemplates
              .filter((item) => item.id !== template?.id);
            this.plugin.settings.activeAiPromptTemplateId = this.plugin.settings.aiPromptTemplates[0]?.id;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("模板名称")
      .addText((text) => {
        text
          .setPlaceholder("模板名称")
          .setValue(template.name)
          .onChange(async (value) => {
            template!.name = value || "未命名模板";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("提示词内容")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.addClass("ob-ki-front-input");
        text
          .setValue(template.prompt)
          .onChange(async (value) => {
            template!.prompt = value;
            await this.plugin.saveSettings();
          });
      });
  }

  private renderCreateHotkeySetting(
    containerEl: HTMLElement,
    label: string,
    key: "createBasicCardHotkey" | "createExerciseCardHotkey" | "createMicroDeckHotkey" | "showAnswerHotkey",
  ) {
    let input: TextComponent | undefined;
    new Setting(containerEl)
      .setName(label)
      .setDesc("在 Markdown 编辑器中选中文本后触发。默认 Mod 在 Windows/Linux 是 Ctrl，在 macOS 是 Command。")
      .addText((text) => {
        input = text;
        text.setValue(this.plugin.settings[key]);
        text.inputEl.readOnly = true;
        text.inputEl.addClass("ob-ki-hotkey-input");
      })
      .addButton((button) => {
        button.setButtonText("录制").onClick(() => {
          if (!input) return;
          input.setValue("按下新的快捷键...");

          const handler = async (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();

            const shortcut = shortcutFromEvent(event);
            if (!shortcut) return;

            window.removeEventListener("keydown", handler, true);
            this.plugin.settings[key] = shortcut;
            await this.plugin.saveSettings();
            this.display();
            new Notice(`${label} 已设为 ${shortcut}`);
          };

          window.addEventListener("keydown", handler, true);
        });
      })
      .addButton((button) => {
        button.setButtonText("恢复默认").onClick(async () => {
          this.plugin.settings[key] = DEFAULT_SETTINGS[key];
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  private renderHotkeySetting(containerEl: HTMLElement, label: string, grade: ReviewGrade) {
    let input: TextComponent | undefined;
    new Setting(containerEl)
      .setName(`${label} 快捷键`)
      .setDesc("复习界面显示答案后生效。")
      .addText((text) => {
        input = text;
        text.setValue(this.plugin.settings.gradeHotkeys[grade]);
        text.inputEl.readOnly = true;
        text.inputEl.addClass("ob-ki-hotkey-input");
      })
      .addButton((button) => {
        button.setButtonText("录制").onClick(() => {
          if (!input) return;
          input.setValue("按下新的快捷键...");

          const handler = async (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();

            const shortcut = shortcutFromEvent(event);
            if (!shortcut) return;

            window.removeEventListener("keydown", handler, true);
            this.plugin.settings.gradeHotkeys[grade] = shortcut;
            await this.plugin.saveSettings();
            this.display();
            new Notice(`${label} 快捷键已设为 ${shortcut}`);
          };

          window.addEventListener("keydown", handler, true);
        });
      })
      .addButton((button) => {
        button.setButtonText("恢复默认").onClick(async () => {
          this.plugin.settings.gradeHotkeys[grade] = DEFAULT_SETTINGS.gradeHotkeys[grade];
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }
}

class AddCardModal extends Modal {
  private front = "";
  private exerciseAnswer = "";
  private exerciseSplitIndex?: number;
  private cardType: CardType = "basic";
  private deckId: string;
  private microDeckId = "";
  private newMicroDeckName = "新微卡组";
  private newMicroDeckParentId = "";

  constructor(
    app: App,
    private plugin: ObKiPlugin,
    private back: string,
    private sourceFile?: TFile | null,
    initialCardType: CardType = "basic",
    private sourceLine?: number,
  ) {
    super(app);
    this.cardType = initialCardType;
    this.deckId = plugin.settings.defaultDeckMode === "first"
      ? plugin.data.decks[0]?.id ?? ""
      : plugin.getDeck()?.id ?? "";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");

    contentEl.createEl("h2", { text: "创建卡片" });
    contentEl.createEl("p", {
      text: "可以创建普通问答卡，也可以从这段 Markdown 里再截取题目和解答。",
      cls: "ob-ki-muted",
    });

    new Setting(contentEl)
      .setName("卡组")
      .addDropdown((dropdown) => {
        this.plugin.data.decks.forEach((deck) => dropdown.addOption(deck.id, deck.name));
        dropdown.setValue(this.deckId);
        dropdown.onChange((value) => {
          this.deckId = value;
          this.microDeckId = "";
          this.newMicroDeckParentId = "";
          this.onOpen();
        });
      });

    new Setting(contentEl)
      .setName("微卡组")
      .setDesc("可选。不选则放在卡组顶层。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "卡组顶层");
        dropdown.addOption("__new__", "+ 新建微卡组");
        const deck = this.plugin.getDeck(this.deckId);
        if (deck) {
          normalizeDeckStudyOrder(deck);
          flattenMicroDeckItems(deck.studyOrder ?? []).forEach(({ microDeck, depth }) => {
            dropdown.addOption(microDeck.id, `${"　".repeat(depth)}${microDeck.name}`);
          });
        }
        dropdown.setValue(this.microDeckId);
        dropdown.onChange((value) => {
          this.microDeckId = value;
          if (value !== "__new__") this.newMicroDeckParentId = "";
          this.onOpen();
        });
      });

    if (this.microDeckId === "__new__") {
      new Setting(contentEl)
        .setName("新微卡组名称")
        .addText((text) => {
          text.setValue(this.newMicroDeckName);
          text.onChange((value) => {
            this.newMicroDeckName = value;
          });
          requestAnimationFrame(() => {
            text.inputEl.focus();
            text.inputEl.select();
          });
        });

      new Setting(contentEl)
        .setName("新微卡组位置")
        .setDesc("可选。选择一个父级微卡组即可创建为子微卡组。")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "卡组顶层");
          const deck = this.plugin.getDeck(this.deckId);
          if (deck) {
            normalizeDeckStudyOrder(deck);
            flattenMicroDeckItems(deck.studyOrder ?? []).forEach(({ microDeck, depth }) => {
              dropdown.addOption(microDeck.id, `${"　".repeat(depth)}${microDeck.name}`);
            });
          }
          dropdown.setValue(this.newMicroDeckParentId);
          dropdown.onChange((value) => {
            this.newMicroDeckParentId = value;
          });
        });
    }

    new Setting(contentEl)
      .setName("卡片类型")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("basic", "基础")
          .addOption("exercise", "习题")
          .setValue(this.cardType)
          .onChange((value: CardType) => {
            this.cardType = value;
            this.onOpen();
          });
      });

    if (this.cardType === "basic") {
      const preview = contentEl.createDiv({ cls: "ob-ki-selection-preview" });
      preview.createEl("div", { text: "背面预览", cls: "ob-ki-preview-label" });
      renderMarkdownWithLinkNavigation(this.app, this.plugin, this.back, preview.createDiv(), this.sourceFile?.path ?? "");

      new Setting(contentEl)
        .setName("正面")
        .setDesc("例如：这个概念的定义是什么？")
        .addTextArea((text) => {
          text.inputEl.rows = 4;
          text.inputEl.addClass("ob-ki-front-input");
          text.setValue(this.front);
          text.onChange((value) => {
            this.front = value;
          });
        });
    } else {
      this.syncExerciseFromSplit();
      const splitter = contentEl.createDiv({ cls: "ob-ki-exercise-splitter" });
      splitter.createDiv({
        text: "在原文中拖动分割线：分割线前为题目，分割线后为解答。",
        cls: "ob-ki-preview-label",
      });

      const editor = splitter.createEl("pre", { cls: "ob-ki-inline-split-editor" });
      const questionText = editor.createEl("span", {
        text: this.front || " ",
        cls: "ob-ki-inline-question",
      });
      const divider = editor.createEl("span", { cls: "ob-ki-inline-divider" });
      divider.setAttr("role", "separator");
      divider.setAttr("aria-orientation", "vertical");
      const answerText = editor.createEl("span", {
        text: this.exerciseAnswer || " ",
        cls: "ob-ki-inline-answer",
      });

      const updateSplit = (clientX: number, clientY: number) => {
        this.exerciseSplitIndex = getTextOffsetFromPoint(editor, clientX, clientY, this.back.length);
        this.syncExerciseFromSplit();
        questionText.setText(this.front || " ");
        answerText.setText(this.exerciseAnswer || " ");
      };

      divider.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        editor.addClass("is-dragging");
      });
      divider.addEventListener("pointermove", (event) => {
        if (!divider.hasPointerCapture(event.pointerId)) return;
        updateSplit(event.clientX, event.clientY);
      });
      divider.addEventListener("pointerup", (event) => {
        if (divider.hasPointerCapture(event.pointerId)) {
          divider.releasePointerCapture(event.pointerId);
        }
        editor.removeClass("is-dragging");
      });
      divider.addEventListener("pointercancel", (event) => {
        if (divider.hasPointerCapture(event.pointerId)) {
          divider.releasePointerCapture(event.pointerId);
        }
        editor.removeClass("is-dragging");
      });
    }

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("添加到卡组")
          .setCta()
          .onClick(async () => {
            const back = this.cardType === "exercise" ? this.exerciseAnswer : this.back;
            if (!this.front.trim()) {
              new Notice(this.cardType === "exercise" ? "请先设置题目。" : "请先填写卡片正面。");
              return;
            }
            if (!back.trim()) {
              new Notice("请先设置解答。");
              return;
            }

            let targetMicroDeckId = this.microDeckId || undefined;
            if (this.microDeckId === "__new__") {
              if (!this.newMicroDeckName.trim()) {
                new Notice("请填写新微卡组名称。");
                return;
              }
              targetMicroDeckId = await this.plugin.createEmptyMicroDeck(
                this.deckId,
                this.newMicroDeckName,
                this.newMicroDeckParentId || undefined,
              );
            }

            await this.plugin.addCard(this.deckId, this.front, back, this.sourceFile, this.cardType, this.sourceLine, targetMicroDeckId);
            new Notice("卡片已添加。");
            this.close();
            if (this.plugin.settings.openViewAfterAdd) {
              await this.plugin.activateView();
            }
          });
      })
      .addButton((button) => {
        button.setButtonText("取消").onClick(() => this.close());
      });
  }

  private syncExerciseFromSplit() {
    const split = this.exerciseSplitIndex ?? findNiceSplitIndex(this.back);
    this.exerciseSplitIndex = Math.min(Math.max(split, 1), Math.max(1, this.back.length - 1));
    this.front = this.back.slice(0, this.exerciseSplitIndex).trim();
    this.exerciseAnswer = this.back.slice(this.exerciseSplitIndex).trim();
  }
}

class AddDeckModal extends Modal {
  private name = "";
  private description = "";

  constructor(app: App, private plugin: ObKiPlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "新建卡组" });

    new Setting(contentEl)
      .setName("名称")
      .addText((text) => text.onChange((value) => {
        this.name = value;
      }));

    new Setting(contentEl)
      .setName("说明")
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.onChange((value) => {
          this.description = value;
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("创建").setCta().onClick(async () => {
          if (!this.name.trim()) {
            new Notice("卡组名称不能为空。");
            return;
          }
          await this.plugin.addDeck(this.name, this.description);
          this.close();
        });
      })
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }
}

class EditDeckModal extends Modal {
  private name: string;
  private description: string;

  constructor(app: App, private plugin: ObKiPlugin, private deck: ObKiDeck) {
    super(app);
    this.name = deck.name;
    this.description = deck.description;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "编辑卡组" });

    new Setting(contentEl)
      .setName("名称")
      .addText((text) => {
        text.setValue(this.name);
        text.onChange((value) => {
          this.name = value;
        });
      });

    new Setting(contentEl)
      .setName("说明")
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.setValue(this.description);
        text.onChange((value) => {
          this.description = value;
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("保存").setCta().onClick(async () => {
          if (!this.name.trim()) {
            new Notice("卡组名称不能为空。");
            return;
          }
          await this.plugin.updateDeck(this.deck.id, this.name, this.description);
          this.close();
        });
      })
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }
}

class RenameDeckFolderModal extends Modal {
  private name: string;

  constructor(app: App, private plugin: ObKiPlugin, private folderId: string, folderName: string) {
    super(app);
    this.name = folderName;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "重命名文件夹" });

    let input!: TextComponent;
    new Setting(contentEl)
      .setName("文件夹名称")
      .addText((text) => {
        input = text;
        text.setValue(this.name);
        text.onChange((value) => {
          this.name = value;
        });
        text.inputEl.addEventListener("keydown", async (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          await this.save();
        });
      });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("保存").setCta().onClick(() => this.save()))
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));

    requestAnimationFrame(() => {
      input.inputEl.focus();
      input.inputEl.select();
    });
  }

  private async save() {
    if (!this.name.trim()) {
      new Notice("文件夹名称不能为空。");
      return;
    }
    await this.plugin.renameDeckFolder(this.folderId, this.name);
    this.close();
  }
}

class RenameMicroDeckModal extends Modal {
  private name: string;

  constructor(
    app: App,
    private plugin: ObKiPlugin,
    private deckId: string,
    private microDeckId: string,
    microDeckName: string,
    private onRenamed?: () => void,
  ) {
    super(app);
    this.name = microDeckName;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "重命名微卡组" });

    let input!: TextComponent;
    new Setting(contentEl)
      .setName("微卡组名称")
      .addText((text) => {
        input = text;
        text.setValue(this.name);
        text.onChange((value) => {
          this.name = value;
        });
        text.inputEl.addEventListener("keydown", async (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          await this.save();
        });
      });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("保存").setCta().onClick(() => this.save()))
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));

    requestAnimationFrame(() => {
      input.inputEl.focus();
      input.inputEl.select();
    });
  }

  private async save() {
    if (!this.name.trim()) {
      new Notice("微卡组名称不能为空。");
      return;
    }
    this.onRenamed?.();
    await this.plugin.renameMicroDeck(this.deckId, this.microDeckId, this.name);
    this.close();
  }
}

class EditCardModal extends Modal {
  private front: string;
  private back: string;
  private type: CardType;
  private sourceLink: string;

  constructor(
    app: App,
    private plugin: ObKiPlugin,
    private deck: ObKiDeck,
    private card: ObKiCard,
  ) {
    super(app);
    this.front = card.front;
    this.back = card.back;
    this.type = card.type ?? "basic";
    this.sourceLink = card.sourceLink || (card.sourcePath ? pathToWikiLink(card.sourcePath) : "");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "编辑卡片" });

    new Setting(contentEl)
      .setName("卡片类型")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("basic", "基础")
          .addOption("exercise", "习题")
          .setValue(this.type)
          .onChange((value: CardType) => {
            this.type = value;
          });
      });

    new Setting(contentEl)
      .setName(this.type === "exercise" ? "题目" : "正面")
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.inputEl.addClass("ob-ki-front-input");
        text.setValue(this.front);
        text.onChange((value) => {
          this.front = value;
        });
      });

    new Setting(contentEl)
      .setName(this.type === "exercise" ? "解答" : "背面")
      .addTextArea((text) => {
        text.inputEl.rows = 7;
        text.inputEl.addClass("ob-ki-front-input");
        text.setValue(this.back);
        text.onChange((value) => {
          this.back = value;
        });
      });

    new Setting(contentEl)
      .setName("来源双链")
      .setDesc("例如 [[笔记名]] 或 [[文件夹/笔记名#标题]]。")
      .addText((text) => {
        text
          .setPlaceholder("[[来源笔记]]")
          .setValue(this.sourceLink)
          .onChange((value) => {
            this.sourceLink = value;
          });
      })
      .addButton((button) => {
        button.setButtonText("选择笔记").setIcon("search").onClick(() => {
          new SourceNoteSuggestModal(this.app, (file) => {
            this.sourceLink = pathToWikiLink(file.path);
            this.onOpen();
          }).open();
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("保存").setCta().onClick(async () => {
          if (!this.front.trim() || !this.back.trim()) {
            new Notice("正面和背面都不能为空。");
            return;
          }
          await this.plugin.updateCard(this.deck.id, this.card.id, {
            front: this.front,
            back: this.back,
            type: this.type,
            sourceLink: this.sourceLink,
          });
          this.close();
        });
      })
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }
}

class CardDetailModal extends Modal {
  private sourceLink: string;

  constructor(app: App, private plugin: ObKiPlugin, private deck: ObKiDeck, private card: ObKiCard) {
    super(app);
    this.sourceLink = card.sourceLink || (card.sourcePath ? pathToWikiLink(card.sourcePath) : "");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "卡片详情" });

    const meta = contentEl.createDiv({ cls: "ob-ki-detail-grid" });
    this.detail(meta, "类型", this.card.type === "exercise" ? "习题" : "基础");
    this.detail(meta, "状态", formatFsrsState(this.card));
    this.detail(meta, "到期", formatDue(this.card.dueAt));
    this.detail(meta, "复习次数", String(this.card.reviews));
    this.detail(meta, "遗忘次数", String(this.card.lapses));
    this.detail(meta, "稳定性", roundDisplay(this.card.stability));
    this.detail(meta, "难度", roundDisplay(this.card.difficulty));
    this.detail(meta, "来源", this.sourceLink || "无");

    new Setting(contentEl)
      .setName("来源双链")
      .setDesc("可以手动修复来源，例如 [[笔记名]]。")
      .addText((text) => {
        text
          .setPlaceholder("[[来源笔记]]")
          .setValue(this.sourceLink)
          .onChange((value) => {
            this.sourceLink = value;
          });
      })
      .addButton((button) => {
        button.setButtonText("选择笔记").setIcon("search").onClick(() => {
          new SourceNoteSuggestModal(this.app, (file) => {
            this.sourceLink = pathToWikiLink(file.path);
            this.onOpen();
          }).open();
        });
      })
      .addButton((button) => {
        button.setButtonText("保存来源").onClick(async () => {
          await this.plugin.updateCard(this.deck.id, this.card.id, {
            front: this.card.front,
            back: this.card.back,
            type: this.card.type ?? "basic",
            sourceLink: this.sourceLink,
          });
          this.card.sourceLink = this.sourceLink;
          new Notice("来源已更新。");
        });
      });

    contentEl.createEl("h3", { text: this.card.type === "exercise" ? "题目" : "正面" });
    const front = contentEl.createDiv({ cls: "ob-ki-detail-preview markdown-rendered" });
    renderMarkdownWithLinkNavigation(this.app, this.plugin, this.card.front, front, this.card.sourcePath ?? "");

    contentEl.createEl("h3", { text: this.card.type === "exercise" ? "解答" : "背面" });
    const back = contentEl.createDiv({ cls: "ob-ki-detail-preview markdown-rendered" });
    renderMarkdownWithLinkNavigation(this.app, this.plugin, this.card.back, back, this.card.sourcePath ?? "");

    const history = (this.deck.reviewLog ?? [])
      .filter((log) => log.cardId === this.card.id)
      .slice(-8)
      .reverse();
    contentEl.createEl("h3", { text: "最近评分" });
    const list = contentEl.createDiv({ cls: "ob-ki-detail-history" });
    if (history.length === 0) {
      list.createDiv({ text: "暂无评分记录。", cls: "ob-ki-muted" });
    } else {
      history.forEach((log) => {
        list.createDiv({ text: `${new Date(log.reviewedAt).toLocaleString()} · ${gradeLabel(log.grade)}` });
      });
    }

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("编辑").onClick(() => {
        this.close();
        new EditCardModal(this.app, this.plugin, this.deck, this.card).open();
      }))
      .addButton((button) => button.setButtonText("打开来源").setDisabled(!this.sourceLink).onClick(async () => {
        await this.plugin.openCardSource(this.card);
      }))
      .addButton((button) => button.setButtonText("关闭").onClick(() => this.close()));
  }

  private detail(parent: HTMLElement, label: string, value: string) {
    const item = parent.createDiv({ cls: "ob-ki-detail-item" });
    item.createDiv({ text: label, cls: "ob-ki-detail-label" });
    item.createDiv({ text: value, cls: "ob-ki-detail-value" });
  }
}

class HealthCheckModal extends Modal {
  constructor(
    app: App,
    private plugin: ObKiPlugin,
    private issues: HealthIssue[],
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "EddieCards 健康检查" });

    if (this.issues.length === 0) {
      contentEl.createDiv({ text: "没有发现来源、双链或图片问题。", cls: "ob-ki-muted" });
      return;
    }

    const counts = {
      source: this.issues.filter((issue) => issue.type === "source-missing").length,
      wiki: this.issues.filter((issue) => issue.type === "wiki-missing").length,
      image: this.issues.filter((issue) => issue.type === "image-missing").length,
    };
    contentEl.createDiv({
      text: `发现 ${this.issues.length} 个问题：来源丢失 ${counts.source}，双链断开 ${counts.wiki}，图片丢失 ${counts.image}。`,
      cls: "ob-ki-muted",
    });

    const list = contentEl.createDiv({ cls: "ob-ki-health-list" });
    this.issues.forEach((issue) => {
      const item = list.createDiv({ cls: "ob-ki-health-item" });
      const head = item.createDiv({ cls: "ob-ki-health-head" });
      head.createDiv({ text: healthIssueLabel(issue.type), cls: "ob-ki-chip" });
      head.createDiv({ text: `${issue.deckName} · ${issue.field}`, cls: "ob-ki-card-meta" });
      item.createDiv({ text: stripMarkdownPreview(issue.cardFront).slice(0, 120) || "未命名卡片", cls: "ob-ki-health-card" });
      item.createDiv({ text: issue.target, cls: "ob-ki-health-target" });

      const actions = item.createDiv({ cls: "ob-ki-health-actions" });
      new ButtonComponent(actions)
        .setButtonText("卡片详情")
        .setIcon("info")
        .onClick(() => {
          const deck = this.plugin.getDeck(issue.deckId);
          const card = deck?.cards.find((candidate) => candidate.id === issue.cardId);
          if (deck && card) new CardDetailModal(this.app, this.plugin, deck, card).open();
        });
      new ButtonComponent(actions)
        .setButtonText("打开来源")
        .setIcon("file-search")
        .setDisabled(issue.type === "source-missing")
        .onClick(async () => {
          const deck = this.plugin.getDeck(issue.deckId);
          const card = deck?.cards.find((candidate) => candidate.id === issue.cardId);
          if (card) await this.plugin.openCardSource(card);
        });
    });
  }
}

class MoveCardsModal extends Modal {
  private targetDeckId = "";
  private targetMicroDeckId = "";

  constructor(
    app: App,
    private plugin: ObKiPlugin,
    private fromDeck: ObKiDeck,
    private cardIds: string[],
    private onMoved: () => void,
    private onBeforeMove?: () => void,
  ) {
    super(app);
    this.targetDeckId = fromDeck.id;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "移动卡片" });
    contentEl.createEl("p", {
      text: `将 ${this.cardIds.length} 张卡片移动到指定卡组或微卡组。`,
      cls: "ob-ki-muted",
    });

    new Setting(contentEl)
      .setName("目标卡组")
      .addDropdown((dropdown) => {
        this.plugin.data.decks.forEach((deck) => dropdown.addOption(deck.id, deck.name));
        dropdown.setValue(this.targetDeckId);
        dropdown.onChange((value) => {
          this.targetDeckId = value;
          this.targetMicroDeckId = "";
          this.onOpen();
        });
      });

    new Setting(contentEl)
      .setName("目标微卡组")
      .setDesc("可选。不选则移动到目标卡组顶层。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "卡组顶层");
        const targetDeck = this.plugin.getDeck(this.targetDeckId);
        if (targetDeck) {
          normalizeDeckStudyOrder(targetDeck);
          flattenMicroDeckItems(targetDeck.studyOrder ?? []).forEach(({ microDeck, depth }) => {
            dropdown.addOption(microDeck.id, `${"　".repeat(depth)}${microDeck.name}`);
          });
        }
        dropdown.setValue(this.targetMicroDeckId);
        dropdown.onChange((value) => {
          this.targetMicroDeckId = value;
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("移动")
          .setCta()
          .setDisabled(!this.targetDeckId || (this.targetDeckId === this.fromDeck.id && !this.targetMicroDeckId))
          .onClick(async () => {
            if (!this.targetDeckId) return;
            this.onBeforeMove?.();
            await this.plugin.moveCards(this.cardIds, this.fromDeck.id, this.targetDeckId, this.targetMicroDeckId || undefined);
            this.onMoved();
            this.close();
          });
      })
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }
}

class MoveDeckTreeItemModal extends Modal {
  private targetFolderId = "";

  constructor(
    app: App,
    private plugin: ObKiPlugin,
    private moving: { type: "deck"; deck: ObKiDeck } | { type: "folder"; folder: ObKiDeckFolder },
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    const name = this.moving.type === "deck" ? this.moving.deck.name : this.moving.folder.name;
    contentEl.createEl("h2", { text: "移动到文件夹" });
    contentEl.createEl("p", { text: `移动「${name}」到指定文件夹。`, cls: "ob-ki-muted" });

    normalizeDeckTree(this.plugin.data);
    const folders = flattenDeckFolders(this.plugin.data.deckOrder ?? [])
      .filter(({ folder }) => (
        this.moving.type === "deck"
          ? true
          : folder.id !== this.moving.folder.id && !deckFolderContainsFolder(this.moving.folder, folder.id)
      ));

    new Setting(contentEl)
      .setName("目标文件夹")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "顶层");
        folders.forEach(({ folder, depth }) => {
          dropdown.addOption(folder.id, `${"　".repeat(depth)}${folder.name}`);
        });
        dropdown.setValue(this.targetFolderId);
        dropdown.onChange((value) => {
          this.targetFolderId = value;
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("移动").setCta().onClick(async () => {
          if (this.moving.type === "deck") {
            await this.plugin.moveDeckToFolder(this.moving.deck.id, this.targetFolderId || undefined);
          } else {
            await this.plugin.moveDeckFolderToFolder(this.moving.folder.id, this.targetFolderId || undefined);
          }
          this.close();
        });
      })
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }
}

class CreateMicroDeckModal extends Modal {
  private name = "";
  private parentMicroDeckId = "";
  private lockedParentMicroDeckId?: string;

  constructor(
    app: App,
    private plugin: ObKiPlugin,
    private deck: ObKiDeck,
    private cardIds: string[],
    private onCreated: () => void,
    private onBeforeCreate?: () => void,
  ) {
    super(app);
    normalizeDeckStudyOrder(deck);
    const parents = getSelectedCardParentMicroDeckIds(deck.studyOrder ?? [], cardIds);
    if (parents.size === 1) {
      const [parentId] = [...parents];
      if (parentId) {
        this.lockedParentMicroDeckId = parentId;
        this.parentMicroDeckId = parentId;
      }
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "创建微卡组" });
    contentEl.createEl("p", {
      text: `将 ${this.cardIds.length} 张选中卡片组成一个有序微卡组。`,
      cls: "ob-ki-muted",
    });

    new Setting(contentEl)
      .setName("名称")
      .addText((text) => {
        text
          .setPlaceholder("例如：极限定义前置概念")
          .setValue(this.name)
          .onChange((value) => {
            this.name = value;
          });
      });

    new Setting(contentEl)
      .setName("放入")
      .setDesc(this.lockedParentMicroDeckId ? "在微卡组内选中的卡片会组成当前微卡组下的子微卡组。" : "可以放在卡组顶层，也可以嵌套进已有微卡组。")
      .addDropdown((dropdown) => {
        normalizeDeckStudyOrder(this.deck);
        const microDecks = flattenMicroDeckItems(this.deck.studyOrder ?? []);
        if (this.lockedParentMicroDeckId) {
          const locked = microDecks.find(({ microDeck }) => microDeck.id === this.lockedParentMicroDeckId);
          dropdown.addOption(this.lockedParentMicroDeckId, locked?.microDeck.name ?? "当前微卡组");
          dropdown.setDisabled(true);
        } else {
          dropdown.addOption("", "顶层");
          microDecks.forEach(({ microDeck, depth }) => {
            dropdown.addOption(microDeck.id, `${"　".repeat(depth)}${microDeck.name}`);
          });
        }
        dropdown.setValue(this.parentMicroDeckId);
        dropdown.onChange((value) => {
          this.parentMicroDeckId = value;
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("创建").setCta().onClick(async () => {
          this.onBeforeCreate?.();
          await this.plugin.createMicroDeck(this.deck.id, this.name, this.cardIds, this.parentMicroDeckId || undefined);
          this.onCreated();
          this.close();
        });
      })
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }
}

class AddToMicroDeckModal extends Modal {
  private targetMicroDeckId = "";

  constructor(
    app: App,
    private plugin: ObKiPlugin,
    private deck: ObKiDeck,
    private cardIds: string[],
    private onAdded: () => void,
    private onBeforeAdd?: () => void,
  ) {
    super(app);
    normalizeDeckStudyOrder(deck);
    this.targetMicroDeckId = flattenMicroDeckItems(deck.studyOrder ?? []).map((item) => item.microDeck.id)[0] ?? "";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "加入微卡组" });
    contentEl.createEl("p", { text: `将 ${this.cardIds.length} 张卡片加入指定微卡组。`, cls: "ob-ki-muted" });

    normalizeDeckStudyOrder(this.deck);
    const microDecks = flattenMicroDeckItems(this.deck.studyOrder ?? []);
    if (microDecks.length === 0) {
      contentEl.createDiv({ text: "当前没有微卡组。", cls: "ob-ki-muted" });
      return;
    }

    new Setting(contentEl)
      .setName("目标微卡组")
      .addDropdown((dropdown) => {
        microDecks.forEach(({ microDeck, depth }) => {
          dropdown.addOption(microDeck.id, `${"　".repeat(depth)}${microDeck.name}`);
        });
        dropdown.setValue(this.targetMicroDeckId);
        dropdown.onChange((value) => {
          this.targetMicroDeckId = value;
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("加入").setCta().onClick(async () => {
          this.onBeforeAdd?.();
          await this.plugin.addCardsToMicroDeck(this.deck.id, this.targetMicroDeckId, this.cardIds);
          this.onAdded();
          this.close();
        });
      })
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }
}

class MoveMicroDeckModal extends Modal {
  private targetDeckId = "";
  private targetMicroDeckId = "";

  constructor(
    app: App,
    private plugin: ObKiPlugin,
    private deck: ObKiDeck,
    private microDeck: ObKiMicroDeck,
    private onMoved: () => void,
    private onBeforeMove?: () => void,
  ) {
    super(app);
    this.targetDeckId = deck.id;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "移动微卡组" });
    contentEl.createEl("p", { text: `把「${this.microDeck.name}」移动到指定卡组或微卡组下。`, cls: "ob-ki-muted" });

    new Setting(contentEl)
      .setName("目标卡组")
      .addDropdown((dropdown) => {
        this.plugin.data.decks.forEach((deck) => dropdown.addOption(deck.id, deck.name));
        dropdown.setValue(this.targetDeckId);
        dropdown.onChange((value) => {
          this.targetDeckId = value;
          this.targetMicroDeckId = "";
          this.onOpen();
        });
      });

    new Setting(contentEl)
      .setName("目标微卡组")
      .setDesc("可选。不选则移动到目标卡组顶层。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "卡组顶层");
        const targetDeck = this.plugin.getDeck(this.targetDeckId);
        if (!targetDeck) return;
        normalizeDeckStudyOrder(targetDeck);
        const targets = flattenMicroDeckItems(targetDeck.studyOrder ?? [])
          .filter(({ microDeck }) => (
            this.targetDeckId !== this.deck.id
            || (microDeck.id !== this.microDeck.id && !microDeckContainsMicroDeck(this.microDeck, microDeck.id))
          ));
        targets.forEach(({ microDeck, depth }) => {
          dropdown.addOption(microDeck.id, `${"　".repeat(depth)}${microDeck.name}`);
        });
        dropdown.setValue(this.targetMicroDeckId);
        dropdown.onChange((value) => {
          this.targetMicroDeckId = value;
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("移动").setCta().onClick(async () => {
          this.onBeforeMove?.();
          await this.plugin.moveMicroDeckToDeck(this.deck.id, this.microDeck.id, this.targetDeckId, this.targetMicroDeckId || undefined);
          this.onMoved();
          this.close();
        });
      })
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }
}

class SourceNoteSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onChoose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("搜索来源笔记...");
  }

  getItems() {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile) {
    return file.path;
  }

  onChooseItem(file: TFile) {
    this.onChoose(file);
  }
}

class AiGenerateCardsModal extends Modal {
  private deckId: string;
  private prompt: string;
  private promptTemplateId?: string;
  private cardType: CardType = "basic";
  private limit = 10;
  private isGenerating = false;
  private progressMessages: string[] = [];
  private progressEl?: HTMLElement;
  private candidates: Array<AiGeneratedCard & { selected: boolean }> = [];

  constructor(app: App, private plugin: ObKiPlugin, private sourceFile: TFile) {
    super(app);
    this.deckId = plugin.getDeck()?.id ?? plugin.data.decks[0]?.id ?? "";
    const activeTemplate = getActivePromptTemplate(plugin.settings);
    this.promptTemplateId = activeTemplate?.id;
    this.prompt = activeTemplate?.prompt ?? "请根据当前笔记生成闪卡。";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ob-ki-modal");
    contentEl.createEl("h2", { text: "AI 生成闪卡" });
    contentEl.createEl("p", {
      text: `来源：${this.sourceFile.path}`,
      cls: "ob-ki-muted",
    });

    new Setting(contentEl)
      .setName("目标卡组")
      .addDropdown((dropdown) => {
        this.plugin.data.decks.forEach((deck) => dropdown.addOption(deck.id, deck.name));
        dropdown.setValue(this.deckId);
        dropdown.onChange((value) => {
          this.deckId = value;
        });
      });

    new Setting(contentEl)
      .setName("卡片类型")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("basic", "基础")
          .addOption("exercise", "习题")
          .setValue(this.cardType)
          .onChange((value: CardType) => {
            this.cardType = value;
          });
      });

    new Setting(contentEl)
      .setName("最多生成")
      .addText((text) => {
        text
          .setValue(String(this.limit))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
              this.limit = parsed;
            }
          });
      });

    new Setting(contentEl)
      .setName("提示词模板")
      .addDropdown((dropdown) => {
        this.plugin.settings.aiPromptTemplates.forEach((template) => {
          dropdown.addOption(template.id, template.name);
        });
        if (this.promptTemplateId) dropdown.setValue(this.promptTemplateId);
        dropdown.onChange(async (value) => {
          const template = this.plugin.settings.aiPromptTemplates.find((item) => item.id === value);
          this.promptTemplateId = value;
          if (template) {
            this.prompt = template.prompt;
            this.plugin.settings.activeAiPromptTemplateId = template.id;
            await this.plugin.saveSettings();
            this.onOpen();
          }
        });
      });

    new Setting(contentEl)
      .setName("提示词")
      .setDesc("告诉 AI 如何从当前笔记中提取闪卡。")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.addClass("ob-ki-front-input");
        text.setValue(this.prompt);
        text.onChange((value) => {
          this.prompt = value;
        });
      });

    this.renderCandidates(contentEl);

    const progress = contentEl.createDiv({ cls: "ob-ki-ai-progress" });
    progress.createDiv({ text: "生成过程", cls: "ob-ki-preview-label" });
    this.progressEl = progress.createDiv({ cls: "ob-ki-ai-progress-log" });
    this.renderProgress();

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText(this.isGenerating ? "生成中..." : "生成候选卡")
          .setCta()
          .setDisabled(this.isGenerating)
          .onClick(async () => {
            if (this.isGenerating) return;
            this.isGenerating = true;
            this.progressMessages = [];
            this.onOpen();
            try {
              const cards = await this.plugin.previewCardsWithAi(
                this.sourceFile,
                this.prompt,
                this.cardType,
                this.limit,
                (message) => this.addProgress(message),
              );
              this.candidates = cards.map((card) => ({ ...card, selected: true }));
              this.isGenerating = false;
              this.onOpen();
            } catch (error) {
              console.error("EddieCards AI generation failed", error);
              new Notice("AI 生成失败，请检查接口设置或控制台错误。");
              this.isGenerating = false;
              this.onOpen();
            }
          });
      })
      .addButton((button) => {
        const selectedCount = this.candidates.filter((card) => card.selected).length;
        button
          .setButtonText(`添加选中 ${selectedCount} 张`)
          .setDisabled(this.isGenerating || selectedCount === 0)
          .onClick(async () => {
            let count = 0;
            for (const card of this.candidates.filter((item) => item.selected)) {
              await this.plugin.addCard(this.deckId, card.front, card.back, this.sourceFile, card.type ?? this.cardType);
              count += 1;
            }
            new Notice(`已添加 ${count} 张卡片。`);
            this.close();
          });
      })
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }

  private renderCandidates(contentEl: HTMLElement) {
    if (this.candidates.length === 0) return;

    const wrap = contentEl.createDiv({ cls: "ob-ki-ai-candidates" });
    const head = wrap.createDiv({ cls: "ob-ki-ai-candidates-head" });
    head.createDiv({ text: "候选卡片", cls: "ob-ki-preview-label" });
    new ButtonComponent(head)
      .setButtonText(this.candidates.every((card) => card.selected) ? "取消全选" : "全选")
      .onClick(() => {
        const next = !this.candidates.every((card) => card.selected);
        this.candidates.forEach((card) => {
          card.selected = next;
        });
        this.onOpen();
      });

    this.candidates.forEach((card, index) => {
      const item = wrap.createDiv({ cls: "ob-ki-ai-candidate" });
      const check = item.createEl("input", { type: "checkbox" });
      check.checked = card.selected;
      check.addEventListener("change", () => {
        card.selected = check.checked;
        this.onOpen();
      });
      const fields = item.createDiv({ cls: "ob-ki-ai-candidate-fields" });
      fields.createDiv({ text: `候选 ${index + 1}`, cls: "ob-ki-card-meta" });
      const front = fields.createEl("textarea");
      front.rows = 3;
      front.value = card.front;
      front.addEventListener("input", () => {
        card.front = front.value;
      });
      const back = fields.createEl("textarea");
      back.rows = 4;
      back.value = card.back;
      back.addEventListener("input", () => {
        card.back = back.value;
      });
    });
  }

  private addProgress(message: string) {
    this.progressMessages.push(`${new Date().toLocaleTimeString()} ${message}`);
    this.renderProgress();
  }

  private renderProgress() {
    if (!this.progressEl) return;
    this.progressEl.empty();
    if (this.progressMessages.length === 0) {
      this.progressEl.createDiv({ text: "等待开始生成...", cls: "ob-ki-muted" });
      return;
    }
    this.progressMessages.forEach((message) => {
      this.progressEl?.createDiv({ text: message });
    });
    this.progressEl.scrollTop = this.progressEl.scrollHeight;
  }
}

class ObKiDeckView extends ItemView {
  private mode: "deck" | "review" | "early-review" | "full-review" | "suspended-full-review" = "deck";
  private currentCardId?: string;
  private reviewQueue: string[] = [];
  private earlyReviewQueue: string[] = [];
  private answerVisible = false;
  private refreshTimer?: number;
  private searchQuery = "";
  private filter: "all" | "basic" | "exercise" | "due" | "new" | "learning" = "all";
  private sort: "createdDesc" | "dueAsc" | "reviewsDesc" | "updatedDesc" = "createdDesc";
  private selectedCardIds = new Set<string>();
  private lastSelectedCardId?: string;
  private collapsedMicroDeckIds = new Set<string>();
  private collapsedDeckFolderIds = new Set<string>();
  private sidebarCollapsed = false;
  private pendingScrollSnapshot?: ScrollSnapshot;

  constructor(leaf: WorkspaceLeaf, private plugin: ObKiPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_OB_KI;
  }

  getDisplayText() {
    return "EddieCards";
  }

  getIcon() {
    return "layers";
  }

  async handleGradeHotkey(event: KeyboardEvent) {
    if (this.mode === "deck" && matchesShortcut(event, this.plugin.settings.createMicroDeckHotkey)) {
      const deck = this.plugin.getDeck();
      if (deck && this.selectedCardIds.size > 0) {
        new CreateMicroDeckModal(
          this.app,
          this.plugin,
          deck,
          [...this.selectedCardIds],
          () => {},
          () => this.prepareMutationRefresh(),
        ).open();
        return true;
      }
    }

    if ((this.mode !== "review" && this.mode !== "early-review" && this.mode !== "full-review") || !this.currentCardId) {
      return false;
    }

    if (!this.answerVisible && matchesShortcut(event, this.plugin.settings.showAnswerHotkey)) {
      this.answerVisible = true;
      this.render();
      return true;
    }

    if (!this.answerVisible) return false;

    const entry = (Object.entries(this.plugin.settings.gradeHotkeys) as Array<[ReviewGrade, string]>)
      .find(([, shortcut]) => matchesShortcut(event, shortcut));
    if (!entry) return false;

    await this.applyGrade(entry[0]);
    return true;
  }

  async onOpen() {
    this.render();
    this.configureRefreshTimer();
  }

  async onClose() {
    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  configureRefreshTimer() {
    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    const seconds = this.plugin.settings.autoRefreshSeconds;
    if (seconds > 0) {
      this.refreshTimer = window.setInterval(() => this.render(), seconds * 1000);
    }
  }

  render() {
    const root = this.containerEl.children[1];
    const snapshot = this.pendingScrollSnapshot ?? this.captureScrollSnapshot();
    this.pendingScrollSnapshot = undefined;
    root.empty();
    root.addClass("ob-ki-view");

    const shell = root.createDiv({ cls: `ob-ki-shell${this.sidebarCollapsed ? " is-sidebar-collapsed" : ""}` });
    this.renderSidebar(shell);
    this.renderMain(shell);
    requestAnimationFrame(() => {
      this.restoreScrollSnapshot(snapshot);
      requestAnimationFrame(() => {
        this.restoreScrollSnapshot(snapshot);
      });
    });
  }

  private rerenderPreserveScroll() {
    this.preserveNextRenderScroll();
    this.render();
  }

  private preserveNextRenderScroll() {
    this.pendingScrollSnapshot = this.captureScrollSnapshot();
  }

  private captureScrollSnapshot() {
    const root = this.containerEl.children[1];
    const main = root.querySelector<HTMLElement>(".ob-ki-main");
    const scrollFrame = main ?? root;
    const frameTop = scrollFrame.getBoundingClientRect().top;
    const anchor = Array.from(root.querySelectorAll<HTMLElement>("[data-ob-ki-order-id]"))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= frameTop && rect.top <= frameTop + scrollFrame.clientHeight)
      .sort((a, b) => Math.abs(a.rect.top - frameTop) - Math.abs(b.rect.top - frameTop))[0];
    return {
      root: root.scrollTop,
      main: main?.scrollTop ?? 0,
      anchorId: anchor?.element.getAttr("data-ob-ki-order-id") ?? "",
      anchorOffset: anchor ? anchor.rect.top - frameTop : 0,
    };
  }

  private restoreScrollSnapshot(snapshot: ScrollSnapshot) {
    const root = this.containerEl.children[1];
    root.scrollTop = snapshot.root;
    const main = root.querySelector<HTMLElement>(".ob-ki-main");
    if (main) main.scrollTop = snapshot.main;
    if (!snapshot.anchorId) return;

    const anchor = Array.from(root.querySelectorAll<HTMLElement>("[data-ob-ki-order-id]"))
      .find((element) => element.getAttr("data-ob-ki-order-id") === snapshot.anchorId);
    if (!anchor) return;

    const scrollFrame = main ?? root;
    const desiredTop = scrollFrame.getBoundingClientRect().top + snapshot.anchorOffset;
    const delta = anchor.getBoundingClientRect().top - desiredTop;
    if (Math.abs(delta) < 1) return;
    if (main && main.scrollHeight > main.clientHeight) {
      main.scrollTop += delta;
    } else {
      root.scrollTop += delta;
      anchor.scrollIntoView({ block: "nearest" });
    }
  }

  private prepareMutationRefresh() {
    this.preserveNextRenderScroll();
    this.selectedCardIds.clear();
  }

  private renderSidebar(shell: HTMLElement) {
    const sidebar = shell.createEl("aside", { cls: `ob-ki-sidebar${this.sidebarCollapsed ? " is-collapsed" : ""}` });
    if (this.sidebarCollapsed) {
      new ButtonComponent(sidebar.createDiv({ cls: "ob-ki-sidebar-toggle-wrap" }))
        .setIcon("panel-right-open")
        .setTooltip("展开卡组栏")
        .onClick(() => {
          this.sidebarCollapsed = false;
          this.rerenderPreserveScroll();
        });
      return;
    }

    const brand = sidebar.createDiv({ cls: "ob-ki-brand" });
    const brandRow = brand.createDiv({ cls: "ob-ki-brand-row" });
    const brandCopy = brandRow.createDiv();
    brandCopy.createDiv({ text: "EddieCards", cls: "ob-ki-title" });
    brandCopy.createDiv({ text: "Markdown flashcards", cls: "ob-ki-subtitle" });
    new ButtonComponent(brandRow)
      .setIcon("panel-left-close")
      .setTooltip("收起卡组栏")
      .onClick(() => {
        this.sidebarCollapsed = true;
        this.rerenderPreserveScroll();
      });

    new ButtonComponent(sidebar.createDiv({ cls: "ob-ki-add-deck" }))
      .setButtonText("新建卡组")
      .setIcon("plus")
      .onClick(() => new AddDeckModal(this.app, this.plugin).open());
    new ButtonComponent(sidebar.createDiv({ cls: "ob-ki-add-deck" }))
      .setButtonText("新建文件夹")
      .setIcon("folder-plus")
      .onClick(async () => {
        await this.plugin.createDeckFolder();
      });

    const list = sidebar.createDiv({ cls: "ob-ki-deck-list" });
    normalizeDeckTree(this.plugin.data);
    this.renderDeckTreeItems(list, this.plugin.data.deckOrder ?? [], 0);
  }

  private renderDeckTreeItems(parent: HTMLElement, items: ObKiDeckTreeItem[], depth: number) {
    items.forEach((treeItem) => {
      if (treeItem.type === "deck") {
        const deck = this.plugin.data.decks.find((candidate) => candidate.id === treeItem.deckId);
        if (!deck) return;
        const active = this.plugin.getDeck()?.id === deck.id;
        const stats = getDeckStats(deck);
        const item = parent.createDiv({
          cls: `ob-ki-deck-item${active ? " is-active" : ""}`,
        });
        item.style.marginLeft = `${depth * 12}px`;
        item.createDiv({ text: deck.name, cls: "ob-ki-deck-name" });
        item.createDiv({
          text: `${stats.due} 到期 · ${deck.cards.length} 张`,
          cls: "ob-ki-deck-meta",
        });
        item.oncontextmenu = (event) => this.openDeckContextMenu(event, deck);
        item.onClickEvent(async () => {
          this.mode = "deck";
          this.currentCardId = undefined;
          this.reviewQueue = [];
          this.earlyReviewQueue = [];
          this.selectedCardIds.clear();
          await this.plugin.setActiveDeck(deck.id);
        });
        return;
      }

      const collapsed = this.collapsedDeckFolderIds.has(treeItem.folder.id);
      const folderItem = parent.createDiv({ cls: `ob-ki-deck-item is-folder${collapsed ? " is-collapsed" : ""}` });
      folderItem.style.marginLeft = `${depth * 12}px`;
      folderItem.createDiv({ text: `${collapsed ? "▸" : "▾"} 📁 ${treeItem.folder.name}`, cls: "ob-ki-deck-name" });
      folderItem.createDiv({ text: `${countDeckTreeDecks(treeItem.folder)} 个卡组`, cls: "ob-ki-deck-meta" });
      folderItem.oncontextmenu = (event) => this.openDeckFolderContextMenu(event, treeItem.folder);
      folderItem.onClickEvent(() => {
        if (collapsed) {
          this.collapsedDeckFolderIds.delete(treeItem.folder.id);
        } else {
          this.collapsedDeckFolderIds.add(treeItem.folder.id);
        }
        this.rerenderPreserveScroll();
      });
      if (!collapsed) {
        this.renderDeckTreeItems(parent, treeItem.folder.items, depth + 1);
      }
    });
  }

  private openDeckContextMenu(event: MouseEvent, deck: ObKiDeck) {
    event.preventDefault();
    event.stopPropagation();
    normalizeDeckTree(this.plugin.data);
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("开始复习").setIcon("play").onClick(() => {
      this.startReview(deck);
      this.render();
    }));
    menu.addItem((item) => item.setTitle("提前复习").setIcon("calendar-clock").onClick(() => {
      this.startEarlyReview(deck);
      this.render();
    }));
    menu.addItem((item) => item.setTitle("全量复习").setIcon("list-checks").onClick(() => {
      this.startFullReview(deck);
      this.render();
    }));
    menu.addItem((item) => item
      .setTitle(`挂起全量复习 (${deck.cards.length})`)
      .setIcon("pause")
      .setDisabled(deck.cards.length === 0)
      .onClick(() => {
        this.startSuspendedFullReview(deck);
        this.render();
      }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("撤销评分").setIcon("undo-2").onClick(async () => {
      await this.plugin.undoLastReview();
    }));
    menu.addItem((item) => item.setTitle("编辑卡组").setIcon("pencil").onClick(() => {
      new EditDeckModal(this.app, this.plugin, deck).open();
    }));
    menu.addItem((item) => item.setTitle("新建空微卡组").setIcon("folder-plus").onClick(async () => {
      this.preserveNextRenderScroll();
      const microDeckId = await this.plugin.createEmptyMicroDeck(deck.id, "新微卡组");
      if (!microDeckId) return;
      if (this.plugin.getDeck()?.id !== deck.id) {
        await this.plugin.setActiveDeck(deck.id);
      }
      new RenameMicroDeckModal(this.app, this.plugin, deck.id, microDeckId, "新微卡组", () => {
        this.preserveNextRenderScroll();
      }).open();
    }));
    menu.addItem((item) => item.setTitle("移动到文件夹").setIcon("folder-input").onClick(() => {
      new MoveDeckTreeItemModal(this.app, this.plugin, { type: "deck", deck }).open();
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("导出 Anki").setIcon("download").onClick(async () => {
      await this.plugin.exportDeckToAnki(deck.id);
    }));
    menu.addItem((item) => item.setTitle("AI 制卡").setIcon("sparkles").onClick(() => {
      this.plugin.openAiGenerateModal();
    }));
    menu.addItem((item) => item.setTitle("健康检查").setIcon("shield-check").onClick(async () => {
      const issues = await this.plugin.scanHealth();
      new HealthCheckModal(this.app, this.plugin, issues).open();
    }));
    menu.addItem((item) => item.setTitle("备份").setIcon("archive").onClick(async () => {
      await this.plugin.exportBackup();
    }));
    menu.addItem((item) => item.setTitle("恢复").setIcon("upload").onClick(() => {
      this.plugin.importBackupFromPicker();
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("删除卡组").setIcon("trash").onClick(async () => {
      await this.plugin.deleteDeck(deck.id);
    }));
    menu.showAtMouseEvent(event);
  }

  private openDeckFolderContextMenu(event: MouseEvent, folder: ObKiDeckFolder) {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("重命名文件夹").setIcon("pencil").onClick(() => {
      new RenameDeckFolderModal(this.app, this.plugin, folder.id, folder.name).open();
    }));
    menu.addItem((item) => item.setTitle("添加子文件夹").setIcon("folder-plus").onClick(async () => {
      await this.plugin.createDeckFolder(folder.id);
    }));
    menu.addItem((item) => item.setTitle("移动到文件夹").setIcon("folder-input").onClick(() => {
      new MoveDeckTreeItemModal(this.app, this.plugin, { type: "folder", folder }).open();
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("解散文件夹").setIcon("folder-open").onClick(async () => {
      await this.plugin.dissolveDeckFolder(folder.id);
    }));
    menu.addItem((item) => item.setTitle("删除文件夹").setIcon("trash-2").onClick(async () => {
      await this.plugin.deleteDeckFolder(folder.id);
    }));
    menu.showAtMouseEvent(event);
  }

  private renderMain(shell: HTMLElement) {
    const deck = this.plugin.getDeck();
    const main = shell.createEl("main", { cls: "ob-ki-main" });
    if (!deck) {
      main.createEl("h2", { text: "还没有卡组" });
      return;
    }

    if (this.mode === "review" || this.mode === "early-review" || this.mode === "full-review" || this.mode === "suspended-full-review") {
      this.renderReview(main, deck, this.mode);
    } else {
      this.renderDeck(main, deck);
    }
  }

  private startReview(deck: ObKiDeck) {
    const now = Date.now();
    const dueCards = deck.cards.filter((card) => !card.suspended && card.dueAt <= now);
    this.mode = "review";
    this.currentCardId = undefined;
    this.reviewQueue = this.orderCardsForReview(deck, this.applyDailyLimits(deck, dueCards), false).map((card) => card.id);
    this.earlyReviewQueue = [];
    this.answerVisible = false;
  }

  private startMicroDeckReview(deck: ObKiDeck, microDeck: ObKiMicroDeck, full: boolean) {
    const cardIds = new Set(getMicroDeckCardIds(microDeck));
    const scopedCards = deck.cards.filter((card) => cardIds.has(card.id) && !card.suspended);
    this.mode = full ? "full-review" : "review";
    this.currentCardId = undefined;
    this.reviewQueue = full ? [] : this.orderCardsForReview(
      deck,
      this.applyDailyLimits(deck, scopedCards.filter((card) => card.dueAt <= Date.now())),
      false,
    ).map((card) => card.id);
    this.earlyReviewQueue = full ? this.orderCardsForReview(deck, scopedCards, true).map((card) => card.id) : [];
    this.answerVisible = false;
  }

  private startEarlyReview(deck: ObKiDeck) {
    this.mode = "early-review";
    this.currentCardId = undefined;
    this.reviewQueue = [];
    this.earlyReviewQueue = this.orderCardsForReview(deck, deck.cards.filter((card) => !card.suspended), true).map((card) => card.id);
    this.answerVisible = false;
  }

  private startFullReview(deck: ObKiDeck) {
    this.mode = "full-review";
    this.currentCardId = undefined;
    this.reviewQueue = [];
    this.earlyReviewQueue = this.orderCardsForReview(deck, deck.cards.filter((card) => !card.suspended), true).map((card) => card.id);
    this.answerVisible = false;
  }

  private startSuspendedFullReview(deck: ObKiDeck) {
    this.mode = "suspended-full-review";
    this.currentCardId = undefined;
    this.reviewQueue = [];
    this.earlyReviewQueue = this.orderCardsForReview(deck, deck.cards, true).map((card) => card.id);
    this.answerVisible = false;
  }

  private startMicroDeckSuspendedFullReview(deck: ObKiDeck, microDeck: ObKiMicroDeck) {
    const cardIds = new Set(getMicroDeckCardIds(microDeck));
    const scopedCards = deck.cards.filter((card) => cardIds.has(card.id));
    this.mode = "suspended-full-review";
    this.currentCardId = undefined;
    this.reviewQueue = [];
    this.earlyReviewQueue = this.orderCardsForReview(deck, scopedCards, true).map((card) => card.id);
    this.answerVisible = false;
  }

  private renderDeck(main: HTMLElement, deck: ObKiDeck) {
    const stats = getDeckStats(deck);
    const header = main.createDiv({ cls: "ob-ki-hero" });
    header.oncontextmenu = (event) => this.openDeckContextMenu(event, deck);
    const copy = header.createDiv();
    copy.createEl("h1", { text: deck.name });
    copy.createEl("p", {
      text: deck.description || "右键卡组标题或左侧卡组，可以打开复习、导出、AI 制卡等操作。",
    });

    const statGrid = main.createDiv({ cls: "ob-ki-stats" });
    this.renderStat(statGrid, "今日到期", stats.due.toString());
    this.renderStat(statGrid, "全部卡片", deck.cards.length.toString());
    this.renderStat(statGrid, "已复习", stats.reviewed.toString());
    this.renderStat(statGrid, "学习中", `${stats.learning}`);
    this.renderChart(main, deck);
    this.renderDeckSettings(main, deck);
    this.renderCardControls(main, deck);

    const section = main.createDiv({ cls: "ob-ki-section-head" });
    section.createEl("h2", { text: "卡片" });
    section.createEl("span", { text: `${this.getVisibleCards(deck).length} / ${deck.cards.length} 张` });

    if (deck.cards.length === 0) {
      const empty = main.createDiv({ cls: "ob-ki-empty" });
      empty.createEl("h3", { text: "还没有卡片" });
      empty.createEl("p", {
        text: "在编辑器里选中一段 Markdown，按 Ctrl/Cmd + Shift + A，就可以把它作为背面添加到卡组。",
      });
      return;
    }

    this.renderMicroDecks(main, deck);
  }

  private renderReview(main: HTMLElement, deck: ObKiDeck, reviewMode: "review" | "early-review" | "full-review" | "suspended-full-review") {
    const includeEarly = reviewMode !== "review";
    const now = Date.now();
    const dueCount = deck.cards.filter((card) => !card.suspended && card.dueAt <= now).length;
    const card = this.pickReviewCard(deck, includeEarly, reviewMode === "suspended-full-review");

    const bar = main.createDiv({ cls: "ob-ki-review-bar" });
    new ButtonComponent(bar)
      .setIcon("arrow-left")
      .setTooltip("返回卡组")
      .onClick(() => {
        this.mode = "deck";
        this.currentCardId = undefined;
        this.reviewQueue = [];
        this.earlyReviewQueue = [];
        this.answerVisible = false;
        this.render();
    });
    bar.createDiv({
      text: reviewMode === "suspended-full-review"
        ? `${deck.name} · 挂起全量复习 · 不计入 FSRS`
        : reviewMode === "full-review"
        ? `${deck.name} · 全量复习 · 不计入 FSRS`
        : reviewMode === "early-review"
          ? `${deck.name} · 提前复习 · 不计入 FSRS`
        : `${deck.name} · ${dueCount} 张到期`,
      cls: "ob-ki-review-title",
    });
    new ButtonComponent(bar)
      .setIcon("undo-2")
      .setTooltip("撤销最近评分")
      .onClick(async () => {
        await this.plugin.undoLastReview();
        this.render();
      });

    if (!card) {
      const done = main.createDiv({ cls: "ob-ki-review-done" });
      done.createEl("h2", { text: includeEarly ? "这个队列已经结束" : "今天清空了" });
      done.createEl("p", {
        text: reviewMode === "full-review"
          ? "全量复习不会改变 FSRS 进度。"
          : reviewMode === "early-review"
          ? "添加卡片后，就可以用提前复习模式主动练习。"
          : this.limitReached(deck)
            ? "已达到今日学习上限。你可以在设置里调整每日新卡或复习上限。"
            : "这个卡组暂时没有到期卡片。你也可以继续添加新的 Markdown 卡片。",
      });
      return;
    }

    this.currentCardId = card.id;
    const stage = main.createDiv({ cls: "ob-ki-review-stage" });
    stage.createDiv({ text: card.type === "exercise" ? "题目" : "正面", cls: "ob-ki-chip" });
    const front = stage.createDiv({ cls: "ob-ki-review-front markdown-rendered" });
    renderMarkdownWithLinkNavigation(this.app, this, card.front, front, card.sourcePath ?? "");

    if (this.answerVisible) {
      const answer = stage.createDiv({ cls: "ob-ki-answer" });
      const answerHead = answer.createDiv({ cls: "ob-ki-answer-head" });
      answerHead.createDiv({ text: card.type === "exercise" ? "解答" : "背面", cls: "ob-ki-chip" });
      const sourceActions = answerHead.createDiv({ cls: "ob-ki-answer-source-actions" });
      new ButtonComponent(sourceActions)
        .setIcon("file-search")
        .setTooltip("定位到来源笔记")
        .setDisabled(!card.sourceLink && !card.sourcePath)
        .onClick(async () => {
          await this.plugin.openCardSource(card);
        });
      new ButtonComponent(sourceActions)
        .setButtonText("修复来源")
        .setIcon("wrench")
        .onClick(() => {
          new CardDetailModal(this.app, this.plugin, deck, card).open();
        });
      new ButtonComponent(sourceActions)
        .setButtonText("编辑当前卡片")
        .setIcon("pencil")
        .onClick(() => {
          new EditCardModal(this.app, this.plugin, deck, card).open();
        });
      renderMarkdownWithLinkNavigation(this.app, this, card.back, answer.createDiv(), card.sourcePath ?? "");
    } else {
      new ButtonComponent(stage.createDiv({ cls: "ob-ki-reveal" }))
        .setButtonText("显示答案")
        .setIcon("eye")
        .setCta()
        .onClick(() => {
          this.answerVisible = true;
          this.render();
        });
    }

    const grades = main.createDiv({ cls: "ob-ki-grade-row" });
    const gradeButtons: Array<[ReviewGrade, string, string]> = [
      ["again", "重来", "rotate-ccw"],
      ["hard", "困难", "frown"],
      ["good", "良好", "check"],
      ["easy", "简单", "sparkles"],
    ];
    const preview = includeEarly ? null : this.plugin.getScheduler(deck).repeat(toFsrsCard(card), new Date());

    gradeButtons.forEach(([grade, label, icon]) => {
      const nextDue = !includeEarly && grade === "again" && hasImmediateAgainStep(this.plugin.settings.learningSteps)
        ? Date.now()
        : preview?.[toFsrsRating(grade)].card.due.getTime();
      const buttonText = includeEarly
        ? label
        : `${label} · ${formatNextSchedule(nextDue!)}`;
      new ButtonComponent(grades)
        .setButtonText(buttonText)
        .setIcon(icon)
        .setDisabled(!this.answerVisible)
        .onClick(async () => {
          await this.applyGrade(grade);
        });
    });
  }

  private async applyGrade(grade: ReviewGrade) {
    const deck = this.plugin.getDeck();
    if (!deck || !this.currentCardId) return;
    const reviewedCardId = this.currentCardId;

    if (this.mode === "early-review" || this.mode === "full-review" || this.mode === "suspended-full-review") {
      this.earlyReviewQueue = this.earlyReviewQueue.filter((id) => id !== reviewedCardId);
    } else {
      await this.plugin.gradeCard(deck.id, reviewedCardId, grade);
      this.reviewQueue = this.reviewQueue.filter((id) => id !== reviewedCardId);
      const card = deck.cards.find((item) => item.id === reviewedCardId);
      if (card && card.dueAt <= Date.now()) {
        this.reviewQueue.push(reviewedCardId);
      }
    }

    this.answerVisible = false;
    this.currentCardId = undefined;
    this.render();
  }

  private renderStat(parent: HTMLElement, label: string, value: string) {
    const item = parent.createDiv({ cls: "ob-ki-stat" });
    item.createDiv({ text: value, cls: "ob-ki-stat-value" });
    item.createDiv({ text: label, cls: "ob-ki-stat-label" });
  }

  private renderChart(parent: HTMLElement, deck: ObKiDeck) {
    const days = getRecentDayKeys(7);
    const counts = days.map((day) => (deck.reviewLog ?? []).filter((log) => dayKey(log.reviewedAt) === day).length);
    const max = Math.max(1, ...counts);
    const chart = parent.createDiv({ cls: "ob-ki-chart" });
    chart.createDiv({ text: "最近 7 天复习", cls: "ob-ki-chart-title" });
    const bars = chart.createDiv({ cls: "ob-ki-chart-bars" });
    days.forEach((day, index) => {
      const item = bars.createDiv({ cls: "ob-ki-chart-bar-item" });
      const bar = item.createDiv({ cls: "ob-ki-chart-bar" });
      bar.style.height = `${Math.max(8, Math.round((counts[index] / max) * 76))}px`;
      item.createDiv({ text: String(counts[index]), cls: "ob-ki-chart-count" });
      item.createDiv({ text: day.slice(5), cls: "ob-ki-chart-label" });
    });
  }

  private renderDeckSettings(parent: HTMLElement, deck: ObKiDeck) {
    const settings = this.plugin.getDeckSettings(deck);
    const panel = parent.createDiv({ cls: "ob-ki-deck-settings" });
    panel.createDiv({ text: "卡组设置", cls: "ob-ki-chart-title" });
    const grid = panel.createDiv({ cls: "ob-ki-deck-settings-grid" });

    this.renderNumberSetting(grid, "保持率 %", Math.round(settings.requestRetention * 100), async (value) => {
      await this.plugin.updateDeckSettings(deck.id, { requestRetention: value / 100 });
    });
    this.renderNumberSetting(grid, "最大间隔", settings.maximumInterval, async (value) => {
      await this.plugin.updateDeckSettings(deck.id, { maximumInterval: value });
    });
    this.renderNumberSetting(grid, "新卡上限", settings.dailyNewLimit, async (value) => {
      await this.plugin.updateDeckSettings(deck.id, { dailyNewLimit: value });
    });
    this.renderNumberSetting(grid, "复习上限", settings.dailyReviewLimit, async (value) => {
      await this.plugin.updateDeckSettings(deck.id, { dailyReviewLimit: value });
    });
    this.renderToggleSetting(grid, "自定义排序", settings.useCustomStudyOrder, async (value) => {
      await this.plugin.updateDeckSettings(deck.id, { useCustomStudyOrder: value });
    });
  }

  private renderNumberSetting(parent: HTMLElement, label: string, value: number, onSave: (value: number) => Promise<void>) {
    const item = parent.createDiv({ cls: "ob-ki-mini-setting" });
    item.createEl("label", { text: label });
    const input = item.createEl("input", { type: "number", value: String(value) });
    input.addEventListener("change", async () => {
      const parsed = Number.parseFloat(input.value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        await onSave(parsed);
      }
    });
  }

  private renderToggleSetting(parent: HTMLElement, label: string, value: boolean, onSave: (value: boolean) => Promise<void>) {
    const item = parent.createDiv({ cls: "ob-ki-mini-setting" });
    item.createEl("label", { text: label });
    const input = item.createEl("input", { type: "checkbox" });
    input.checked = value;
    input.addEventListener("change", async () => {
      await onSave(input.checked);
    });
  }

  private renderCardControls(parent: HTMLElement, deck: ObKiDeck) {
    const controls = parent.createDiv({ cls: "ob-ki-card-controls" });
    const visibleCards = this.getVisibleCards(deck);
    const search = controls.createEl("input", {
      type: "search",
      placeholder: "搜索卡片...",
      value: this.searchQuery,
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.searchQuery = search.value;
        this.render();
      }
    });

    new ButtonComponent(controls)
      .setButtonText("搜索")
      .setIcon("search")
      .onClick(() => {
        this.searchQuery = search.value;
        this.render();
      });

    new ButtonComponent(controls)
      .setButtonText("清空")
      .setIcon("x")
      .setDisabled(!this.searchQuery)
      .onClick(() => {
        this.searchQuery = "";
        this.render();
      });

    const filter = controls.createEl("select");
    [
      ["all", "全部"],
      ["basic", "基础"],
      ["exercise", "习题"],
      ["due", "到期"],
      ["new", "新卡"],
      ["learning", "学习中"],
    ].forEach(([value, label]) => filter.createEl("option", { value, text: label }));
    filter.value = this.filter;
    filter.addEventListener("change", () => {
      this.filter = filter.value as typeof this.filter;
      this.render();
    });

    const sort = controls.createEl("select");
    [
      ["createdDesc", "最近创建"],
      ["dueAsc", "最早到期"],
      ["reviewsDesc", "复习最多"],
      ["updatedDesc", "最近修改"],
    ].forEach(([value, label]) => sort.createEl("option", { value, text: label }));
    sort.value = this.sort;
    sort.addEventListener("change", () => {
      this.sort = sort.value as typeof this.sort;
      this.render();
    });

    const batch = controls.createDiv({ cls: "ob-ki-batch-actions" });
    batch.createSpan({ text: `已选 ${this.selectedCardIds.size}` });
    const allVisibleSelected = visibleCards.length > 0 && visibleCards.every((card) => this.selectedCardIds.has(card.id));
    new ButtonComponent(batch)
      .setButtonText(allVisibleSelected ? "取消全选" : "全选当前")
      .setDisabled(visibleCards.length === 0)
      .onClick(() => {
        if (allVisibleSelected) {
          visibleCards.forEach((card) => this.selectedCardIds.delete(card.id));
        } else {
          visibleCards.forEach((card) => this.selectedCardIds.add(card.id));
        }
        this.lastSelectedCardId = visibleCards.at(-1)?.id;
        this.render();
      });
    new ButtonComponent(batch)
      .setIcon("more-horizontal")
      .setTooltip("批量操作")
      .onClick((event) => {
        this.openBatchContextMenu(event as MouseEvent, deck);
      });
  }

  private renderMicroDecks(parent: HTMLElement, deck: ObKiDeck) {
    normalizeDeckStudyOrder(deck);
    const panel = parent.createDiv({ cls: "ob-ki-micro-panel" });
    panel.oncontextmenu = (event) => this.openStudyOrderPanelContextMenu(event, deck);
    const head = panel.createDiv({ cls: "ob-ki-micro-head" });
    head.createDiv({ text: "卡片与学习顺序", cls: "ob-ki-chart-title" });
    head.createDiv({ text: "拖动卡片或微卡组调整复习顺序。", cls: "ob-ki-muted" });

    if (!deck.studyOrder?.length) {
      panel.createDiv({ text: "暂无卡片。", cls: "ob-ki-muted" });
      return;
    }

    const tree = panel.createDiv({ cls: "ob-ki-micro-tree ob-ki-card-list" });
    const visibleCardIds = new Set(this.getVisibleCards(deck).map((card) => card.id));
    this.renderOrderItems(tree, deck, deck.studyOrder, undefined, 0, visibleCardIds);
  }

  private openStudyOrderPanelContextMenu(event: MouseEvent, deck: ObKiDeck) {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("新建空微卡组").setIcon("folder-plus").onClick(async () => {
      this.preserveNextRenderScroll();
      const microDeckId = await this.plugin.createEmptyMicroDeck(deck.id, "新微卡组");
      if (!microDeckId) return;
      new RenameMicroDeckModal(this.app, this.plugin, deck.id, microDeckId, "新微卡组", () => {
        this.preserveNextRenderScroll();
      }).open();
    }));
    menu.showAtMouseEvent(event);
  }

  private renderOrderItems(parent: HTMLElement, deck: ObKiDeck, items: ObKiMicroDeckItem[], parentMicroDeckId: string | undefined, depth: number, visibleCardIds?: Set<string>) {
    items.forEach((item, index) => {
      if (visibleCardIds && !orderItemHasVisibleCard(item, visibleCardIds)) return;
      const row = parent.createDiv({ cls: `ob-ki-order-item${item.type === "microDeck" ? " is-folder" : ""}` });
      row.setAttr("data-ob-ki-order-id", item.type === "card" ? `card:${item.cardId}` : `micro:${item.microDeck.id}`);
      row.style.marginLeft = `${depth * 18}px`;
      row.draggable = true;
      row.setAttr("data-index", String(index));
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("text/plain", `${parentMicroDeckId ?? "root"}:${index}`);
      });
      row.addEventListener("dragover", (event) => event.preventDefault());
      row.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const payload = event.dataTransfer?.getData("text/plain") ?? "";
        const [sourceParentId, sourceIndex] = payload.split(":");
        const from = Number.parseInt(sourceIndex, 10);
        if (!Number.isFinite(from)) return;
        if (item.type === "microDeck" && sourceParentId !== item.microDeck.id) {
          this.prepareMutationRefresh();
          this.collapsedMicroDeckIds.delete(item.microDeck.id);
          await this.plugin.moveStudyOrderItemToMicroDeck(
            deck.id,
            sourceParentId === "root" ? undefined : sourceParentId,
            from,
            item.microDeck.id,
          );
          return;
        }
        if (sourceParentId !== (parentMicroDeckId ?? "root") || from === index) return;
        this.prepareMutationRefresh();
        await this.plugin.reorderStudyOrderItem(deck.id, parentMicroDeckId, from, index);
      });

      row.createSpan({ text: "☰", cls: "ob-ki-micro-grip" });
      if (item.type === "card") {
        const card = deck.cards.find((candidate) => candidate.id === item.cardId);
        if (card) {
          row.addClass("is-card");
          if (this.selectedCardIds.has(card.id)) row.addClass("is-selected");
          const checkbox = row.createEl("input", { type: "checkbox", cls: "ob-ki-card-check" });
          checkbox.checked = this.selectedCardIds.has(card.id);
          checkbox.addEventListener("click", (event) => {
            event.stopPropagation();
            this.toggleCardSelection(deck, card.id, event.shiftKey, checkbox.checked);
          });
          const content = row.createDiv({ cls: "ob-ki-card-row-content" });
          const front = content.createDiv({ cls: "ob-ki-card-front markdown-rendered" });
          renderMarkdownWithLinkNavigation(this.app, this, card.front, front, card.sourcePath ?? "");
          if (card.suspended) row.addClass("is-suspended");
          content.createDiv({
            text: `${card.type === "exercise" ? "习题" : "基础"} · ${card.suspended ? "已挂起" : formatDue(card.dueAt)} · 复习 ${card.reviews} 次 · ${formatFsrsState(card)}`,
            cls: "ob-ki-card-meta",
          });
          row.oncontextmenu = (event) => this.openCardContextMenu(event, deck, card);
        } else {
          row.createSpan({ text: "已删除卡片", cls: "ob-ki-micro-title" });
        }
      } else {
        row.createSpan({ text: `📁 ${item.microDeck.name}`, cls: "ob-ki-micro-title" });
        row.createSpan({ text: `${countMicroDeckCards(item.microDeck)} 张`, cls: "ob-ki-card-meta" });
        row.oncontextmenu = (event) => {
          this.openMicroDeckContextMenu(event, deck, item.microDeck, parentMicroDeckId, index);
        };
        const collapsed = this.collapsedMicroDeckIds.has(item.microDeck.id);
        if (collapsed) row.addClass("is-collapsed");
        new ButtonComponent(row)
          .setIcon(collapsed ? "chevron-right" : "chevron-down")
          .setTooltip(collapsed ? "展开微卡组" : "折叠微卡组")
          .onClick((event) => {
            event.preventDefault();
            event.stopPropagation();
            if (this.collapsedMicroDeckIds.has(item.microDeck.id)) {
              this.collapsedMicroDeckIds.delete(item.microDeck.id);
            } else {
              this.collapsedMicroDeckIds.add(item.microDeck.id);
            }
            this.rerenderPreserveScroll();
          });
        if (!collapsed) {
          this.renderOrderItems(parent, deck, item.microDeck.items, item.microDeck.id, depth + 1, visibleCardIds);
        }
      }
      if (item.type === "card" && parentMicroDeckId) {
        new ButtonComponent(row)
          .setIcon("log-out")
          .setTooltip("移出微卡组")
          .onClick(async () => {
            this.prepareMutationRefresh();
            await this.plugin.moveItemOutOfMicroDeck(deck.id, parentMicroDeckId, index);
          });
      }
    });
  }

  private toggleCardSelection(deck: ObKiDeck, cardId: string, shiftKey: boolean, selected: boolean) {
    if (shiftKey && this.lastSelectedCardId) {
      const cardIds = this.getSelectableCardIds(deck);
      const start = cardIds.indexOf(this.lastSelectedCardId);
      const end = cardIds.indexOf(cardId);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        cardIds.slice(from, to + 1).forEach((id) => {
          if (selected) {
            this.selectedCardIds.add(id);
          } else {
            this.selectedCardIds.delete(id);
          }
        });
      } else if (selected) {
        this.selectedCardIds.add(cardId);
      } else {
        this.selectedCardIds.delete(cardId);
      }
    } else if (selected) {
      this.selectedCardIds.add(cardId);
    } else {
      this.selectedCardIds.delete(cardId);
    }

    this.lastSelectedCardId = cardId;
    this.rerenderPreserveScroll();
  }

  private getSelectableCardIds(deck: ObKiDeck) {
    normalizeDeckStudyOrder(deck);
    const ids: string[] = [];
    const visibleCards = new Set(this.getVisibleCards(deck).map((card) => card.id));
    const visit = (items: ObKiMicroDeckItem[]) => {
      items.forEach((item) => {
        if (item.type === "card") {
          if (visibleCards.has(item.cardId)) ids.push(item.cardId);
          return;
        }
        if (!this.collapsedMicroDeckIds.has(item.microDeck.id)) {
          visit(item.microDeck.items);
        }
      });
    };
    visit(deck.studyOrder ?? []);
    return ids;
  }

  private openCardContextMenu(event: MouseEvent, deck: ObKiDeck, card: ObKiCard) {
    event.preventDefault();
    event.stopPropagation();
    normalizeDeckStudyOrder(deck);
    const microDecks = flattenMicroDeckItems(deck.studyOrder ?? []);
    const activeIds = this.selectedCardIds.has(card.id) ? [...this.selectedCardIds] : [card.id];
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("查看详情").setIcon("info").onClick(() => {
      new CardDetailModal(this.app, this.plugin, deck, card).open();
    }));
    menu.addItem((item) => item.setTitle("编辑卡片").setIcon("pencil").onClick(() => {
      new EditCardModal(this.app, this.plugin, deck, card).open();
    }));
    menu.addItem((item) => item.setTitle("打开来源").setIcon("file-search").onClick(async () => {
      await this.plugin.openCardSource(card);
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(this.selectedCardIds.has(card.id) ? "取消选择" : "加入选择").setIcon("check-square").onClick(() => {
      if (this.selectedCardIds.has(card.id)) {
        this.selectedCardIds.delete(card.id);
      } else {
        this.selectedCardIds.add(card.id);
      }
      this.rerenderPreserveScroll();
    }));
    menu.addItem((item) => item.setTitle("用选中卡片组成微卡组").setIcon("folder-plus").setDisabled(this.selectedCardIds.size === 0).onClick(() => {
      new CreateMicroDeckModal(this.app, this.plugin, deck, [...this.selectedCardIds], () => {
      }, () => this.prepareMutationRefresh()).open();
    }));
    menu.addItem((item) => item.setTitle(`加入指定微卡组 (${activeIds.length})`).setIcon("folder-input").setDisabled(microDecks.length === 0).onClick(() => {
      new AddToMicroDeckModal(this.app, this.plugin, deck, activeIds, () => {
      }, () => this.prepareMutationRefresh()).open();
    }));
    menu.addItem((item) => item.setTitle(`移动到卡组/微卡组 (${activeIds.length})`).setIcon("move-right").onClick(() => {
      new MoveCardsModal(this.app, this.plugin, deck, activeIds, () => {
      }, () => this.prepareMutationRefresh()).open();
    }));
    menu.addSeparator();
    const allActiveSuspended = activeIds.every((id) => deck.cards.find((item) => item.id === id)?.suspended);
    menu.addItem((item) => item
      .setTitle(`${allActiveSuspended ? "取消挂起" : "挂起"}${activeIds.length > 1 ? `选中卡片 (${activeIds.length})` : "卡片"}`)
      .setIcon(allActiveSuspended ? "play" : "pause")
      .onClick(async () => {
      this.prepareMutationRefresh();
      await this.plugin.setCardsSuspended(deck.id, activeIds, !allActiveSuspended);
    }));
    menu.addItem((item) => item.setTitle("重置学习进度").setIcon("rotate-ccw").onClick(async () => {
      this.prepareMutationRefresh();
      await this.plugin.resetCards(deck.id, [card.id]);
    }));
    menu.addItem((item) => item.setTitle("删除卡片").setIcon("trash-2").onClick(async () => {
      this.prepareMutationRefresh();
      await this.plugin.deleteCard(deck.id, card.id);
    }));
    menu.showAtMouseEvent(event);
  }

  private openBatchContextMenu(event: MouseEvent, deck: ObKiDeck) {
    event.preventDefault();
    const ids = [...this.selectedCardIds];
    normalizeDeckStudyOrder(deck);
    const microDecks = flattenMicroDeckItems(deck.studyOrder ?? []);
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(`组成微卡组 (${ids.length})`).setIcon("folder-plus").setDisabled(ids.length === 0).onClick(() => {
      new CreateMicroDeckModal(this.app, this.plugin, deck, ids, () => {
      }, () => this.prepareMutationRefresh()).open();
    }));
    menu.addItem((item) => item.setTitle("加入指定微卡组").setIcon("folder-input").setDisabled(!microDecks.length || ids.length === 0).onClick(() => {
      new AddToMicroDeckModal(this.app, this.plugin, deck, ids, () => {
      }, () => this.prepareMutationRefresh()).open();
    }));
    menu.addItem((item) => item.setTitle("移动到卡组/微卡组").setIcon("move-right").setDisabled(ids.length === 0).onClick(() => {
      new MoveCardsModal(this.app, this.plugin, deck, ids, () => {
      }, () => this.prepareMutationRefresh()).open();
    }));
    const allSuspended = ids.length > 0 && ids.every((id) => deck.cards.find((card) => card.id === id)?.suspended);
    menu.addItem((item) => item.setTitle(allSuspended ? "取消挂起选中卡片" : "挂起选中卡片").setIcon(allSuspended ? "play" : "pause").setDisabled(ids.length === 0).onClick(async () => {
      this.prepareMutationRefresh();
      await this.plugin.setCardsSuspended(deck.id, ids, !allSuspended);
    }));
    menu.addItem((item) => item.setTitle("重置学习进度").setIcon("rotate-ccw").setDisabled(ids.length === 0).onClick(async () => {
      this.prepareMutationRefresh();
      await this.plugin.resetCards(deck.id, ids);
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("删除选中卡片").setIcon("trash-2").setDisabled(ids.length === 0).onClick(async () => {
      this.prepareMutationRefresh();
      await this.plugin.deleteCards(deck.id, ids);
    }));
    menu.showAtMouseEvent(event);
  }

  private openMicroDeckContextMenu(event: MouseEvent, deck: ObKiDeck, microDeck: ObKiMicroDeck, parentMicroDeckId: string | undefined, itemIndex: number) {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    const microDeckCardIds = [...new Set(getMicroDeckCardIds(microDeck))];
    const allCardsSuspended = microDeckCardIds.length > 0
      && microDeckCardIds.every((id) => deck.cards.find((card) => card.id === id)?.suspended);
    menu.addItem((item) => item.setTitle("重命名微卡组").setIcon("pencil").onClick(() => {
      new RenameMicroDeckModal(this.app, this.plugin, deck.id, microDeck.id, microDeck.name, () => {
        this.preserveNextRenderScroll();
      }).open();
    }));
    menu.addItem((item) => item.setTitle("添加子微卡组").setIcon("folder-plus").onClick(async () => {
      this.prepareMutationRefresh();
      this.collapsedMicroDeckIds.delete(microDeck.id);
      const childId = await this.plugin.createChildMicroDeck(deck.id, microDeck.id);
      if (childId) {
        new RenameMicroDeckModal(this.app, this.plugin, deck.id, childId, "子微卡组", () => {
          this.preserveNextRenderScroll();
        }).open();
      }
    }));
    menu.addItem((item) => item.setTitle("移动到卡组/微卡组").setIcon("folder-input").onClick(() => {
      new MoveMicroDeckModal(this.app, this.plugin, deck, microDeck, () => {
      }, () => this.prepareMutationRefresh()).open();
    }));
    menu.addItem((item) => item
      .setTitle(allCardsSuspended ? `取消挂起此微卡组 (${microDeckCardIds.length})` : `挂起此微卡组 (${microDeckCardIds.length})`)
      .setIcon(allCardsSuspended ? "play" : "pause")
      .setDisabled(microDeckCardIds.length === 0)
      .onClick(async () => {
        this.prepareMutationRefresh();
        await this.plugin.setCardsSuspended(deck.id, microDeckCardIds, !allCardsSuspended);
      }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("复习此微卡组").setIcon("play").onClick(() => {
      this.startMicroDeckReview(deck, microDeck, false);
      this.render();
    }));
    menu.addItem((item) => item.setTitle("全量复习此微卡组").setIcon("list-checks").onClick(() => {
      this.startMicroDeckReview(deck, microDeck, true);
      this.render();
    }));
    menu.addItem((item) => item
      .setTitle(`挂起全量复习此微卡组 (${microDeckCardIds.length})`)
      .setIcon("pause")
      .setDisabled(microDeckCardIds.length === 0)
      .onClick(() => {
        this.startMicroDeckSuspendedFullReview(deck, microDeck);
        this.render();
      }));
    if (parentMicroDeckId) {
      menu.addItem((item) => item.setTitle("移出上级微卡组").setIcon("log-out").onClick(async () => {
        this.prepareMutationRefresh();
        await this.plugin.moveItemOutOfMicroDeck(deck.id, parentMicroDeckId, itemIndex);
      }));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("解散微卡组").setIcon("folder-open").onClick(async () => {
      this.prepareMutationRefresh();
      await this.plugin.dissolveMicroDeck(deck.id, microDeck.id);
    }));
    menu.addItem((item) => item.setTitle("删除微卡组").setIcon("trash-2").onClick(async () => {
      this.prepareMutationRefresh();
      await this.plugin.deleteMicroDeck(deck.id, microDeck.id);
    }));
    menu.showAtMouseEvent(event);
  }

  private renderCardRow(parent: HTMLElement, deck: ObKiDeck, card: ObKiCard) {
    const row = parent.createDiv({ cls: "ob-ki-card-row" });
    const checkbox = row.createEl("input", { type: "checkbox", cls: "ob-ki-card-check" });
    checkbox.checked = this.selectedCardIds.has(card.id);
    checkbox.addEventListener("change", () => {
      this.toggleCardSelection(deck, card.id, false, checkbox.checked);
    });
    row.oncontextmenu = (event) => {
      this.openCardContextMenu(event, deck, card);
    };
    const content = row.createDiv({ cls: "ob-ki-card-row-content" });
    const front = content.createDiv({ cls: "ob-ki-card-front markdown-rendered" });
    renderMarkdownWithLinkNavigation(this.app, this, card.front, front, card.sourcePath ?? "");
    content.createDiv({
      text: `${card.type === "exercise" ? "习题" : "基础"} · ${card.suspended ? "已挂起" : formatDue(card.dueAt)} · 复习 ${card.reviews} 次 · ${formatFsrsState(card)}`,
      cls: "ob-ki-card-meta",
    });

    new ButtonComponent(row)
      .setIcon("info")
      .setTooltip("卡片详情")
      .onClick(() => {
        new CardDetailModal(this.app, this.plugin, deck, card).open();
      });

    new ButtonComponent(row)
      .setIcon("file-search")
      .setTooltip("打开来源")
      .setDisabled(!card.sourcePath)
      .onClick(async () => {
        await this.plugin.openCardSource(card);
      });

    new ButtonComponent(row)
      .setIcon("pencil")
      .setTooltip("编辑卡片")
      .onClick(() => {
        new EditCardModal(this.app, this.plugin, deck, card).open();
      });

    new ButtonComponent(row)
      .setIcon("trash-2")
      .setTooltip("删除卡片")
      .onClick(async () => {
        await this.plugin.deleteCard(deck.id, card.id);
      });
  }

  private getVisibleCards(deck: ObKiDeck) {
    const now = Date.now();
    const query = this.searchQuery.trim().toLowerCase();
    return deck.cards
      .filter((card) => {
        if (this.filter === "basic" && (card.type ?? "basic") !== "basic") return false;
        if (this.filter === "exercise" && card.type !== "exercise") return false;
        if (this.filter === "due" && (card.suspended || card.dueAt > now)) return false;
        if (this.filter === "new" && card.reviews > 0) return false;
        if (this.filter === "learning" && card.state !== State.Learning && card.state !== State.Relearning) return false;
        if (!query) return true;
        return `${card.front}\n${card.back}\n${card.sourcePath ?? ""}`.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        if (this.sort === "dueAsc") return a.dueAt - b.dueAt;
        if (this.sort === "reviewsDesc") return b.reviews - a.reviews;
        if (this.sort === "updatedDesc") return b.updatedAt - a.updatedAt;
        return b.createdAt - a.createdAt;
      });
  }

  private pickReviewCard(deck: ObKiDeck, includeEarly: boolean, includeSuspended = false) {
    if (this.currentCardId) {
      const current = deck.cards.find((card) => card.id === this.currentCardId);
      if (current && (includeSuspended || !current.suspended) && (includeEarly || current.dueAt <= Date.now())) return current;
    }
    if (includeEarly) {
      const nextId = this.earlyReviewQueue.find((id) => deck.cards.some((card) => card.id === id && (includeSuspended || !card.suspended)));
      return deck.cards.find((card) => card.id === nextId);
    }
    const nextId = this.reviewQueue.find((id) => deck.cards.some((card) => card.id === id && !card.suspended && card.dueAt <= Date.now()));
    return deck.cards.find((card) => card.id === nextId);
  }

  private orderCardsForReview(deck: ObKiDeck, cards: ObKiCard[], includeEarly: boolean) {
    const settings = this.plugin.getDeckSettings(deck);
    if (!settings.useCustomStudyOrder) {
      return cards.slice().sort((a, b) => a.dueAt - b.dueAt);
    }
    const order = getMicroDeckCardOrder(deck);
    return cards.slice().sort((a, b) => {
      const aOrder = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return includeEarly ? a.createdAt - b.createdAt : a.dueAt - b.dueAt;
    });
  }

  private applyDailyLimits(deck: ObKiDeck, cards: ObKiCard[]) {
    const counts = getTodayReviewCounts(deck);
    const settings = this.plugin.getDeckSettings(deck);
    return cards.filter((card) => {
      if (card.reviews === 0 && settings.dailyNewLimit > 0) {
        return counts.newCount < settings.dailyNewLimit;
      }
      if (card.reviews > 0 && settings.dailyReviewLimit > 0) {
        return counts.reviewCount < settings.dailyReviewLimit;
      }
      return true;
    });
  }

  private limitReached(deck: ObKiDeck) {
    const counts = getTodayReviewCounts(deck);
    const settings = this.plugin.getDeckSettings(deck);
    return (settings.dailyNewLimit > 0 && counts.newCount >= settings.dailyNewLimit)
      || (settings.dailyReviewLimit > 0 && counts.reviewCount >= settings.dailyReviewLimit);
  }
}

function getDeckStats(deck: ObKiDeck) {
  const now = Date.now();
  const due = deck.cards.filter((card) => !card.suspended && card.dueAt <= now).length;
  const reviewed = deck.cards.filter((card) => card.reviews > 0).length;
  const learning = deck.cards.filter((card) => (
    card.state === State.Learning || card.state === State.Relearning
  )).length;

  return { due, reviewed, learning };
}

function renderMarkdownWithLinkNavigation(
  app: App,
  component: Component,
  markdown: string,
  container: HTMLElement,
  sourcePath: string,
) {
  MarkdownRenderer.render(app, markdown, container, sourcePath, component);
  attachInternalLinkNavigation(app, container, sourcePath);
}

function attachInternalLinkNavigation(app: App, container: HTMLElement, sourcePath: string) {
  container.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const link = target?.closest("a.internal-link");
    if (!(link instanceof HTMLAnchorElement)) return;

    const linktext = link.getAttr("data-href")
      ?? link.getAttr("href")
      ?? link.textContent
      ?? "";
    if (!linktext.trim()) return;

    event.preventDefault();
    event.stopPropagation();
    app.workspace.openLinkText(linktext, sourcePath, "tab");
  });
}

function pathToWikiLink(path: string) {
  const withoutExtension = path.replace(/\.md$/i, "");
  return `[[${withoutExtension}]]`;
}

function wikiLinkToLinkText(link: string) {
  const trimmed = link.trim();
  const wiki = trimmed.match(/^\[\[([\s\S]+?)\]\]$/);
  return (wiki?.[1] ?? trimmed).split("|")[0].trim();
}

function stripLinkAliasAndAnchor(linkText: string) {
  return linkText
    .trim()
    .split("|")[0]
    .split("#")[0]
    .trim();
}

function extractWikiLinks(markdown: string) {
  const links: string[] = [];
  const regex = /\[\[([\s\S]+?)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    if (match.index > 0 && markdown[match.index - 1] === "!") continue;
    const link = stripLinkAliasAndAnchor(match[1] ?? "");
    if (link) links.push(link);
  }
  return Array.from(new Set(links));
}

function extractMarkdownImages(markdown: string) {
  const images: string[] = [];
  const embedRegex = /!\[\[([\s\S]+?)\]\]/g;
  let embedMatch: RegExpExecArray | null;
  while ((embedMatch = embedRegex.exec(markdown)) !== null) {
    const image = stripLinkAliasAndAnchor(embedMatch[1] ?? "");
    if (image) images.push(image);
  }

  const markdownImageRegex = /!\[[^\]]*]\(([^)]+)\)/g;
  let imageMatch: RegExpExecArray | null;
  while ((imageMatch = markdownImageRegex.exec(markdown)) !== null) {
    const image = stripLinkAliasAndAnchor((imageMatch[1] ?? "").replace(/^<|>$/g, ""));
    if (image) images.push(image);
  }
  return Array.from(new Set(images));
}

function isExternalUrl(value: string) {
  return /^(https?:|data:|mailto:)/i.test(value.trim());
}

function createHealthIssue(
  type: HealthIssueType,
  deck: ObKiDeck,
  card: ObKiCard,
  field: "来源" | "正面" | "背面",
  target: string,
): HealthIssue {
  return {
    type,
    deckId: deck.id,
    deckName: deck.name,
    cardId: card.id,
    cardFront: card.front,
    field,
    target,
  };
}

function healthIssueLabel(type: HealthIssueType) {
  if (type === "source-missing") return "来源不存在";
  if (type === "wiki-missing") return "双链断开";
  return "图片丢失";
}

function gradeLabel(grade: ReviewGrade) {
  if (grade === "again") return "重来";
  if (grade === "hard") return "困难";
  if (grade === "good") return "良好";
  return "简单";
}

function roundDisplay(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "-";
}

function getTodayReviewCounts(deck: ObKiDeck) {
  const today = dayKey(Date.now());
  const todayLogs = (deck.reviewLog ?? []).filter((log) => dayKey(log.reviewedAt) === today);
  return {
    newCount: todayLogs.filter((log) => log.wasNew).length,
    reviewCount: todayLogs.filter((log) => !log.wasNew).length,
  };
}

function removeCardsFromMicroDecks(microDecks: ObKiMicroDeck[], cardIds: string[]): ObKiMicroDeck[] {
  return microDecks.map((microDeck) => ({
    ...microDeck,
    items: microDeck.items
      .map((item): ObKiMicroDeckItem | undefined => {
        if (item.type === "card") {
          return cardIds.includes(item.cardId) ? undefined : item;
        }
        return {
          type: "microDeck",
          microDeck: {
            ...item.microDeck,
            items: removeCardsFromMicroDecks([item.microDeck], cardIds)[0]?.items ?? [],
          },
        };
      })
      .filter((item): item is ObKiMicroDeckItem => Boolean(item)),
  }));
}

function normalizeDeckStudyOrder(deck?: ObKiDeck) {
  if (!deck) return;
  if (!deck.studyOrder) {
    deck.studyOrder = [
      ...(deck.microDecks ?? []).map((microDeck): ObKiMicroDeckItem => ({ type: "microDeck", microDeck })),
    ];
  }

  const knownCards = new Set<string>();
  const visit = (items: ObKiMicroDeckItem[]) => {
    items.forEach((item) => {
      if (item.type === "card") {
        knownCards.add(item.cardId);
      } else {
        visit(item.microDeck.items);
      }
    });
  };
  visit(deck.studyOrder);

  deck.cards.forEach((card) => {
    if (!knownCards.has(card.id)) {
      deck.studyOrder?.push({ type: "card", cardId: card.id });
    }
  });
}

function normalizeDeckTree(data: ObKiData) {
  const deckIds = new Set(data.decks.map((deck) => deck.id));
  const seen = new Set<string>();
  const visit = (items: ObKiDeckTreeItem[]): ObKiDeckTreeItem[] => items
    .map((item): ObKiDeckTreeItem | undefined => {
      if (item.type === "deck") {
        if (!deckIds.has(item.deckId) || seen.has(item.deckId)) return undefined;
        seen.add(item.deckId);
        return item;
      }
      return {
        type: "folder",
        folder: {
          ...item.folder,
          items: visit(item.folder.items ?? []),
        },
      };
    })
    .filter((item): item is ObKiDeckTreeItem => Boolean(item));

  data.deckOrder = visit(data.deckOrder ?? []);
  data.decks.forEach((deck) => {
    if (!seen.has(deck.id)) {
      data.deckOrder?.push({ type: "deck", deckId: deck.id });
      seen.add(deck.id);
    }
  });
}

function findDeckFolderInItems(items: ObKiDeckTreeItem[], folderId: string): ObKiDeckFolder | undefined {
  for (const item of items) {
    if (item.type !== "folder") continue;
    if (item.folder.id === folderId) return item.folder;
    const child = findDeckFolderInItems(item.folder.items, folderId);
    if (child) return child;
  }
  return undefined;
}

function findParentItemsForDeckFolder(items: ObKiDeckTreeItem[], folderId: string): ObKiDeckTreeItem[] | undefined {
  for (const item of items) {
    if (item.type !== "folder") continue;
    if (item.folder.id === folderId) return items;
    const nested = findParentItemsForDeckFolder(item.folder.items, folderId);
    if (nested) return nested;
  }
  return undefined;
}

function removeDeckFromTree(items: ObKiDeckTreeItem[], deckId: string): ObKiDeckTreeItem[] {
  return items
    .map((item): ObKiDeckTreeItem | undefined => {
      if (item.type === "deck") return item.deckId === deckId ? undefined : item;
      return {
        type: "folder",
        folder: {
          ...item.folder,
          items: removeDeckFromTree(item.folder.items, deckId),
        },
      };
    })
    .filter((item): item is ObKiDeckTreeItem => Boolean(item));
}

function renameDeckFolderInItems(items: ObKiDeckTreeItem[], folderId: string, name: string): ObKiDeckTreeItem[] {
  return items.map((item): ObKiDeckTreeItem => {
    if (item.type === "deck") return item;
    return {
      type: "folder",
      folder: {
        ...item.folder,
        name: item.folder.id === folderId ? name : item.folder.name,
        items: renameDeckFolderInItems(item.folder.items, folderId, name),
      },
    };
  });
}

function deleteDeckFolderById(items: ObKiDeckTreeItem[], folderId: string): ObKiDeckTreeItem[] {
  return items
    .map((item): ObKiDeckTreeItem | undefined => {
      if (item.type === "deck") return item;
      if (item.folder.id === folderId) return undefined;
      return {
        type: "folder",
        folder: {
          ...item.folder,
          items: deleteDeckFolderById(item.folder.items, folderId),
        },
      };
    })
    .filter((item): item is ObKiDeckTreeItem => Boolean(item));
}

function flattenDeckFolders(items: ObKiDeckTreeItem[], depth = 0): Array<{ folder: ObKiDeckFolder; depth: number }> {
  return items.flatMap((item) => {
    if (item.type === "deck") return [];
    return [
      { folder: item.folder, depth },
      ...flattenDeckFolders(item.folder.items, depth + 1),
    ];
  });
}

function deckFolderContainsFolder(folder: ObKiDeckFolder, targetFolderId: string): boolean {
  return folder.items.some((item) => (
    item.type === "folder"
      && (item.folder.id === targetFolderId || deckFolderContainsFolder(item.folder, targetFolderId))
  ));
}

function countDeckTreeDecks(folder: ObKiDeckFolder): number {
  return folder.items.reduce((sum, item) => (
    sum + (item.type === "deck" ? 1 : countDeckTreeDecks(item.folder))
  ), 0);
}

function removeCardsFromOrder(items: ObKiMicroDeckItem[], cardIds: string[]): ObKiMicroDeckItem[] {
  return items
    .map((item): ObKiMicroDeckItem | undefined => {
      if (item.type === "card") {
        return cardIds.includes(item.cardId) ? undefined : item;
      }
      return {
        type: "microDeck",
        microDeck: {
          ...item.microDeck,
          items: removeCardsFromOrder(item.microDeck.items, cardIds),
        },
      };
    })
    .filter((item): item is ObKiMicroDeckItem => Boolean(item));
}

function findMicroDeckInItems(items: ObKiMicroDeckItem[], microDeckId: string): ObKiMicroDeck | undefined {
  for (const item of items) {
    if (item.type !== "microDeck") continue;
    if (item.microDeck.id === microDeckId) return item.microDeck;
    const child = findMicroDeckInItems(item.microDeck.items, microDeckId);
    if (child) return child;
  }
  return undefined;
}

function deleteMicroDeckByIdInItems(items: ObKiMicroDeckItem[], microDeckId: string): ObKiMicroDeckItem[] {
  return items
    .map((item): ObKiMicroDeckItem | undefined => {
      if (item.type === "card") return item;
      if (item.microDeck.id === microDeckId) return undefined;
      return {
        type: "microDeck",
        microDeck: {
          ...item.microDeck,
          items: deleteMicroDeckByIdInItems(item.microDeck.items, microDeckId),
        },
      };
    })
    .filter((item): item is ObKiMicroDeckItem => Boolean(item));
}

function findParentItemsForMicroDeck(items: ObKiMicroDeckItem[], microDeckId: string): ObKiMicroDeckItem[] | undefined {
  for (const item of items) {
    if (item.type !== "microDeck") continue;
    if (item.microDeck.id === microDeckId) return items;
    const nested = findParentItemsForMicroDeck(item.microDeck.items, microDeckId);
    if (nested) return nested;
  }
  return undefined;
}

function findFirstCardInsertion(
  items: ObKiMicroDeckItem[],
  cardIds: string[],
  parentMicroDeckId?: string,
): { parentMicroDeckId?: string; index: number } | undefined {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.type === "card" && cardIds.includes(item.cardId)) {
      return { parentMicroDeckId, index };
    }
    if (item.type === "microDeck") {
      const nested = findFirstCardInsertion(item.microDeck.items, cardIds, item.microDeck.id);
      if (nested) return nested;
    }
  }
  return undefined;
}

function getSelectedCardParentMicroDeckIds(
  items: ObKiMicroDeckItem[],
  cardIds: string[],
  parentMicroDeckId = "",
) {
  const parents = new Set<string>();
  const visit = (currentItems: ObKiMicroDeckItem[], currentParentId: string) => {
    currentItems.forEach((item) => {
      if (item.type === "card") {
        if (cardIds.includes(item.cardId)) parents.add(currentParentId);
      } else {
        visit(item.microDeck.items, item.microDeck.id);
      }
    });
  };
  visit(items, parentMicroDeckId);
  return parents;
}

function microDeckContainsMicroDeck(microDeck: ObKiMicroDeck, targetMicroDeckId: string): boolean {
  return microDeck.items.some((item) => (
    item.type === "microDeck"
      && (item.microDeck.id === targetMicroDeckId || microDeckContainsMicroDeck(item.microDeck, targetMicroDeckId))
  ));
}

function findMicroDeck(microDecks: ObKiMicroDeck[], microDeckId: string): ObKiMicroDeck | undefined {
  for (const microDeck of microDecks) {
    if (microDeck.id === microDeckId) return microDeck;
    const child = findMicroDeck(
      microDeck.items
        .filter((item): item is { type: "microDeck"; microDeck: ObKiMicroDeck } => item.type === "microDeck")
        .map((item) => item.microDeck),
      microDeckId,
    );
    if (child) return child;
  }
  return undefined;
}

function deleteMicroDeckById(microDecks: ObKiMicroDeck[], microDeckId: string): ObKiMicroDeck[] {
  const deleteFromItems = (items: ObKiMicroDeckItem[]) => items
    .map((item): ObKiMicroDeckItem | undefined => {
      if (item.type === "card") return item;
      if (item.microDeck.id === microDeckId) return undefined;
      return {
        type: "microDeck",
        microDeck: {
          ...item.microDeck,
          items: deleteFromItems(item.microDeck.items),
        },
      };
    })
    .filter((item): item is ObKiMicroDeckItem => Boolean(item));

  return microDecks
    .filter((microDeck) => microDeck.id !== microDeckId)
    .map((microDeck) => ({
      ...microDeck,
      items: deleteFromItems(microDeck.items),
    }));
}

function flattenMicroDecks(microDecks: ObKiMicroDeck[], depth = 0): Array<{ microDeck: ObKiMicroDeck; depth: number }> {
  return microDecks.flatMap((microDeck) => [
    { microDeck, depth },
    ...flattenMicroDecks(
      microDeck.items
        .filter((item): item is { type: "microDeck"; microDeck: ObKiMicroDeck } => item.type === "microDeck")
        .map((item) => item.microDeck),
      depth + 1,
    ),
  ]);
}

function flattenMicroDeckItems(items: ObKiMicroDeckItem[], depth = 0): Array<{ microDeck: ObKiMicroDeck; depth: number }> {
  return items.flatMap((item) => {
    if (item.type === "card") return [];
    return [
      { microDeck: item.microDeck, depth },
      ...flattenMicroDeckItems(item.microDeck.items, depth + 1),
    ];
  });
}

function orderItemHasVisibleCard(item: ObKiMicroDeckItem, visibleCardIds: Set<string>): boolean {
  if (item.type === "card") return visibleCardIds.has(item.cardId);
  return true;
}

function getMicroDeckCardOrder(deck: ObKiDeck) {
  normalizeDeckStudyOrder(deck);
  const order = new Map<string, number>();
  let index = 0;
  const visit = (items: ObKiMicroDeckItem[]) => {
    items.forEach((item) => {
      if (item.type === "card") {
        if (!order.has(item.cardId)) {
          order.set(item.cardId, index);
          index += 1;
        }
      } else {
        visit(item.microDeck.items);
      }
    });
  };
  visit(deck.studyOrder ?? []);
  return order;
}

function countMicroDeckCards(microDeck: ObKiMicroDeck): number {
  return microDeck.items.reduce((sum, item) => (
    sum + (item.type === "card" ? 1 : countMicroDeckCards(item.microDeck))
  ), 0);
}

function getMicroDeckCardIds(microDeck: ObKiMicroDeck): string[] {
  return microDeck.items.flatMap((item) => (
    item.type === "card" ? [item.cardId] : getMicroDeckCardIds(item.microDeck)
  ));
}

function stripMarkdownPreview(markdown: string) {
  return markdown
    .replace(/!\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, link: string, alias: string) => alias || link)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_`~$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getRecentDayKeys(count: number) {
  const days: string[] = [];
  const now = new Date();
  for (let index = count - 1; index >= 0; index -= 1) {
    const date = new Date(now);
    date.setDate(now.getDate() - index);
    days.push(dayKey(date.getTime()));
  }
  return days;
}

function dayKey(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDue(dueAt: number) {
  const diff = dueAt - Date.now();
  if (diff <= 0) return "已到期";
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.ceil(hours / 24)} 天后`;
}

function formatNextSchedule(dueAt: number) {
  const diff = Math.max(0, dueAt - Date.now());
  if (diff < 1000) return "马上";
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}天`;
  return `${Math.round(days / 30)}月`;
}

function formatFsrsState(card: ObKiCard) {
  if (card.suspended) return "已挂起";
  if (card.state === State.New) return "新卡";
  if (card.state === State.Learning) return `学习中 · 第 ${card.learningSteps + 1} 步`;
  if (card.state === State.Relearning) return "重新学习";
  if (card.scheduledDays < 30) return `间隔 ${card.scheduledDays} 天`;
  return `间隔 ${Math.round(card.scheduledDays / 30)} 月`;
}

function findNiceSplitIndex(text: string) {
  if (text.length <= 2) return 1;
  const midpoint = Math.floor(text.length / 2);
  const nextBreak = text.slice(midpoint).search(/\n\s*\n|\n/);
  if (nextBreak >= 0) return midpoint + nextBreak;
  const previousBreak = text.slice(0, midpoint).lastIndexOf("\n");
  if (previousBreak > 0) return previousBreak;
  return midpoint;
}

async function firstExistingPath(app: App, paths: string[]) {
  for (const path of paths) {
    if (await app.vault.adapter.exists(path)) return path;
  }
  return undefined;
}

function sanitizeFileName(value: string) {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80);
}

function formatExportTimestamp(date: Date) {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

class AnkiMediaProcessor {
  private mediaBySource = new Map<string, string>();
  private usedNames = new Set<string>();

  constructor(private app: App, private apkg: { addMedia: (filename: string, data: ArrayBuffer) => void }) {}

  async addImage(source: string, sourcePath?: string) {
    const normalizedSource = source.trim();
    if (!normalizedSource) return "";

    const cached = this.mediaBySource.get(`${sourcePath ?? ""}|${normalizedSource}`);
    if (cached) return cached;

    try {
      const data = await this.readImageData(normalizedSource, sourcePath);
      if (!data) return normalizedSource;

      const filename = this.createMediaName(normalizedSource);
      this.apkg.addMedia(filename, data);
      this.mediaBySource.set(`${sourcePath ?? ""}|${normalizedSource}`, filename);
      return filename;
    } catch (error) {
      console.warn(`Ob Ki failed to package image: ${normalizedSource}`, error);
      return normalizedSource;
    }
  }

  private async readImageData(source: string, sourcePath?: string) {
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source);
      if (!response.ok) return undefined;
      return await response.arrayBuffer();
    }

    const file = this.resolveVaultFile(source, sourcePath);
    if (!file) return undefined;
    return await this.app.vault.adapter.readBinary(file.path);
  }

  private resolveVaultFile(source: string, sourcePath?: string) {
    const cleanSource = decodeURIComponent(source.replace(/^<|>$/g, "").split("#")[0]);
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(cleanSource));
    if (direct instanceof TFile) return direct;

    const linked = this.app.metadataCache.getFirstLinkpathDest(cleanSource, sourcePath ?? "");
    if (linked instanceof TFile) return linked;

    if (sourcePath) {
      const folder = sourcePath.includes("/") ? sourcePath.substring(0, sourcePath.lastIndexOf("/")) : "";
      const relative = this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${cleanSource}`));
      if (relative instanceof TFile) return relative;
    }

    return undefined;
  }

  private createMediaName(source: string) {
    const withoutQuery = source.split(/[?#]/)[0];
    const rawName = withoutQuery.substring(withoutQuery.lastIndexOf("/") + 1) || "image";
    const safeName = sanitizeFileName(decodeURIComponent(rawName)) || "image";
    const hasExtension = /\.[a-z0-9]{2,5}$/i.test(safeName);
    const baseName = hasExtension ? safeName : `${safeName}.png`;
    let candidate = baseName;
    let index = 2;

    while (this.usedNames.has(candidate)) {
      const dot = baseName.lastIndexOf(".");
      candidate = dot > 0
        ? `${baseName.slice(0, dot)}-${index}${baseName.slice(dot)}`
        : `${baseName}-${index}`;
      index += 1;
    }

    this.usedNames.add(candidate);
    return candidate;
  }
}

async function markdownToAnkiHtml(markdown: string, media: AnkiMediaProcessor, sourcePath?: string) {
  const placeholders: Record<string, string> = {};
  let index = 0;
  let protectedMarkdown = protectLatex(markdown, placeholders, () => `%%OBKI_LATEX_${index++}%%`);

  let withImages = await replaceAsync(protectedMarkdown, /!\[\[([^\]]+)\]\]/g, async (match, rawTarget: string) => {
    const [target, alt = ""] = rawTarget.split("|");
    const filename = await media.addImage(target, sourcePath);
    if (!filename) return match;
    const placeholder = `%%OBKI_IMAGE_${index++}%%`;
    placeholders[placeholder] = `<img src="${escapeHtml(filename)}" alt="${escapeHtml(alt || target)}">`;
    return placeholder;
  });

  withImages = await replaceAsync(withImages, /!\[([^\]]*)\]\(([^)]+)\)/g, async (match, alt: string, rawSource: string) => {
    const source = rawSource.trim().replace(/^<|>$/g, "").replace(/\s+["'][^"']*["']$/, "");
    const filename = await media.addImage(source, sourcePath);
    if (!filename) return match;
    const placeholder = `%%OBKI_IMAGE_${index++}%%`;
    placeholders[placeholder] = `<img src="${escapeHtml(filename)}" alt="${escapeHtml(alt)}">`;
    return placeholder;
  });

  let html = escapeHtml(withImages)
    .replace(/^###### (.*)$/gm, "<h6>$1</h6>")
    .replace(/^##### (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");

  Object.entries(placeholders).forEach(([placeholder, imageHtml]) => {
    html = html.split(placeholder).join(imageHtml);
  });

  return html;
}

interface AiGeneratedCard {
  front: string;
  back: string;
  type?: CardType;
}

async function requestAiCards(
  settings: ObKiSettings,
  note: string,
  userPrompt: string,
  cardType: CardType,
  limit: number,
  onProgress?: (message: string) => void,
): Promise<AiGeneratedCard[]> {
  const baseUrl = settings.aiBaseUrl.replace(/\/+$/, "");
  onProgress?.(`发送请求到 ${baseUrl}/chat/completions`);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.aiApiKey}`,
    },
    body: JSON.stringify({
      model: settings.aiModel,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "你是一个严谨的闪卡制卡助手。",
            "你必须只输出 JSON，不要输出 Markdown 代码块。",
            "JSON 格式必须是：{\"cards\":[{\"front\":\"...\",\"back\":\"...\",\"type\":\"basic\"}]}。",
            "front 是卡片正面或题目，back 是背面或解答。",
            "不要编造笔记中没有的信息。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `用户要求：${userPrompt}`,
            `卡片类型：${cardType}`,
            `最多生成：${limit}`,
            "当前笔记内容：",
            note.slice(0, 60000),
          ].join("\n\n"),
        },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`AI request failed: ${response.status} ${await response.text()}`);
  }

  onProgress?.("收到模型响应，正在解析...");
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("AI response did not contain message content.");
  }

  const parsed = parseAiJson(content);
  const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
  onProgress?.(`JSON 解析完成，原始返回 ${cards.length} 张卡片。`);
  return cards
    .map((card: Partial<AiGeneratedCard>) => ({
      front: String(card.front ?? "").trim(),
      back: String(card.back ?? "").trim(),
      type: card.type === "exercise" ? "exercise" : cardType,
    }))
    .filter((card: AiGeneratedCard) => card.front && card.back)
    .slice(0, limit);
}

function getActivePromptTemplate(settings: ObKiSettings) {
  return settings.aiPromptTemplates.find((template) => template.id === settings.activeAiPromptTemplateId)
    ?? settings.aiPromptTemplates[0];
}

async function requestAiModels(settings: ObKiSettings): Promise<string[]> {
  const baseUrl = settings.aiBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${settings.aiApiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Model request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const models: string[] = Array.isArray(payload?.data)
    ? payload.data
      .map((item: { id?: unknown }) => String(item.id ?? "").trim())
      .filter((id: string) => id.length > 0)
    : [];

  return Array.from(new Set<string>(models)).sort((a, b) => a.localeCompare(b));
}

function parseAiJson(content: string) {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI response was not valid JSON.");
    return JSON.parse(match[0]);
  }
}

function protectLatex(
  markdown: string,
  placeholders: Record<string, string>,
  nextPlaceholder: () => string,
) {
  let protectedText = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (_match, formula: string) => {
    const placeholder = nextPlaceholder();
    placeholders[placeholder] = `\\[${escapeHtml(formula.trim())}\\]`;
    return placeholder;
  });

  protectedText = protectedText.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_match, prefix: string, formula: string) => {
    const placeholder = nextPlaceholder();
    placeholders[placeholder] = `${prefix}\\(${escapeHtml(formula.trim())}\\)`;
    return placeholder;
  });

  return protectedText;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function replaceAsync(
  value: string,
  regex: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
) {
  const matches = Array.from(value.matchAll(regex));
  const replacements = await Promise.all(matches.map((match) => replacer(match[0], ...match.slice(1))));
  let index = 0;
  return value.replace(regex, () => replacements[index++]);
}

function getTextOffsetFromPoint(container: HTMLElement, clientX: number, clientY: number, textLength: number) {
  const spans = Array.from(container.querySelectorAll("span"));
  let offset = 0;
  let closestOffset = 1;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const span of spans) {
    if (span.classList.contains("ob-ki-inline-divider")) continue;
    const text = span.textContent ?? "";

    for (let index = 0; index <= text.length; index += 1) {
      const range = document.createRange();
      const node = span.firstChild;
      if (!node) continue;
      range.setStart(node, index);
      range.setEnd(node, index);
      const rect = range.getBoundingClientRect();
      range.detach();

      if (rect.width === 0 && rect.height === 0) continue;
      const distance = Math.hypot(clientX - rect.left, clientY - rect.top);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestOffset = offset + index;
      }
    }

    offset += text.length;
  }

  if (Number.isFinite(closestDistance)) {
    return clampTextOffset(closestOffset, textLength);
  }

  return clampTextOffset(Math.round(textLength / 2), textLength);
}

function clampTextOffset(value: number, textLength: number) {
  return Math.min(Math.max(1, value), Math.max(1, textLength - 1));
}

function parseSteps(value: string, fallback: string): StepUnit[] {
  const steps = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is StepUnit => /^\d+(m|h|d)$/.test(item));

  if (steps.length > 0 || value.trim() === "") return steps;
  return fallback
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is StepUnit => /^\d+(m|h|d)$/.test(item));
}

function hasImmediateAgainStep(learningSteps: string) {
  const firstStep = learningSteps.split(",").map((item) => item.trim()).filter(Boolean)[0];
  return firstStep === "0m" || firstStep === "0h" || firstStep === "0d" || firstStep === "0";
}

function shortcutFromEvent(event: KeyboardEvent) {
  const key = normalizeKey(event.key);
  if (!key) return "";

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  if (["Mod", "Alt", "Shift"].includes(key)) return "";
  parts.push(key);
  return parts.join("+");
}

function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts[parts.length - 1];
  if (!key) return false;

  const wantsMod = parts.includes("Mod");
  const wantsAlt = parts.includes("Alt");
  const wantsShift = parts.includes("Shift");
  const hasMod = event.ctrlKey || event.metaKey;

  return normalizeKey(event.key) === key
    && hasMod === wantsMod
    && event.altKey === wantsAlt
    && event.shiftKey === wantsShift;
}

function normalizeKey(key: string) {
  if (key === "Control" || key === "Meta") return "Mod";
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  const aliases: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
  };
  return aliases[key] ?? key;
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function toFsrsRating(grade: ReviewGrade) {
  if (grade === "again") return Rating.Again;
  if (grade === "hard") return Rating.Hard;
  if (grade === "good") return Rating.Good;
  return Rating.Easy;
}

function toFsrsCard(card: ObKiCard): FsrsCard {
  return {
    due: new Date(card.dueAt),
    stability: card.stability ?? 0,
    difficulty: card.difficulty ?? 0,
    elapsed_days: card.elapsedDays ?? 0,
    scheduled_days: card.scheduledDays ?? 0,
    learning_steps: card.learningSteps ?? 0,
    reps: card.reviews ?? 0,
    lapses: card.lapses ?? 0,
    state: card.state ?? State.New,
    last_review: card.lastReviewAt ? new Date(card.lastReviewAt) : undefined,
  };
}

function fromFsrsCard(card: FsrsCard) {
  return {
    dueAt: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reviews: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReviewAt: card.last_review?.getTime(),
  };
}
