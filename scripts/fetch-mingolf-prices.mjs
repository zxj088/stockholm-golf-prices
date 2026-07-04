import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env.local");
const configPath = path.join(root, "config", "mingolf-courses.json");

const env = { ...await loadEnv(envPath), ...process.env };
const username = env.MINGOLF_USERNAME || env.MINGOLF_GOLF_ID || env.MINGOLF_EMAIL;
const password = env.MINGOLF_PASSWORD;
const days = Number(env.MINGOLF_DAYS || 60);
const outputPath = path.resolve(root, env.MINGOLF_OUTPUT || "data/prices.csv");
const discoveryPath = path.resolve(root, env.MINGOLF_DISCOVERY_OUTPUT || "data/mingolf-discovery.json");
const runLogPath = path.join(root, "tmp", "mingolf", "fetch.log");
const headless = String(env.MINGOLF_HEADLESS || "true").toLowerCase() !== "false";
const chromePath = env.MINGOLF_CHROME_PATH || await findSystemChrome();
const courseLimit = Number(env.MINGOLF_COURSE_LIMIT || 0);
const discoverOnly = String(env.MINGOLF_DISCOVER_ONLY || "false").toLowerCase() === "true";
const concurrency = Math.max(1, Math.min(Number(env.MINGOLF_CONCURRENCY || 8), 16));
const hiddenPriceConcurrency = Math.max(1, Math.min(Number(env.MINGOLF_HIDDEN_PRICE_CONCURRENCY || 3), 6));
const hiddenPriceStartHour = Math.max(0, Math.min(Number(env.MINGOLF_HIDDEN_PRICE_START_HOUR || 17), 23));
const hiddenPriceMaxSlotsPerDay = Math.max(1, Math.min(Number(env.MINGOLF_HIDDEN_PRICE_MAX_SLOTS_PER_DAY || 1), 48));

validateSecrets({ username, password, days });

const { chromium } = await loadPlaywright();
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const courses = Number.isInteger(courseLimit) && courseLimit > 0
  ? (config.courses || []).slice(0, courseLimit)
  : (config.courses || []);
const from = startOfDay(new Date());
const to = addDays(from, days - 1);
const captured = [];
const authEvents = [];
const apiSamples = [];
const notes = [];

const browser = await chromium.launch({
  headless,
  executablePath: chromePath || undefined,
});
const context = await browser.newContext({
  locale: "sv-SE",
  timezoneId: "Europe/Stockholm",
});
const page = await context.newPage();

page.on("response", async (response) => {
  const request = response.request();
  if (/login|auth|token|session/i.test(response.url())) {
    authEvents.push({
      url: response.url(),
      status: response.status(),
      method: request.method(),
      type: request.resourceType(),
    });
  }
  const type = request.resourceType();
  const contentType = response.headers()["content-type"] || "";
  if (!["xhr", "fetch"].includes(type) && !contentType.includes("json")) return;
  try {
    const text = await response.text();
    if (!looksRelevant(text)) return;
    captured.push({
      url: response.url(),
      status: response.status(),
      method: request.method(),
      body: tryParseJson(text),
    });
  } catch {
    // Some responses are streamed or already consumed by the browser.
  }
});

try {
  await logStep("Starting login");
  await login(page, username, password);
  await logStep(`Logged in at ${page.url()}`);
  await openBooking(page, notes);
  await logStep(`After openBooking: ${page.url()}`);
  const bookingAssets = await discoverBookingAssets(page);
  if (discoverOnly) {
    await fs.writeFile(path.join(root, "data", "mingolf-booking-assets.json"), `${JSON.stringify(bookingAssets, null, 2)}\n`, "utf8");
    console.log("Saved booking API asset discovery to data/mingolf-booking-assets.json.");
    process.exitCode = 0;
  } else {
    const directRows = await fetchRowsFromBookingApi(page, courses, from, to, notes);
    if (!directRows.length) {
      for (const course of courses) {
        await logStep(`Searching ${course.course_id}`);
        console.log(`Searching ${course.course_id}...`);
        await searchCourse(page, course, from, to, notes);
      }
    }

    const sourceRows = directRows.length ? directRows : extractRows(captured, courses, from, to);
    const rowsWithMinGolfFallback = await applyMinGolfBookingPriceFallback(page, sourceRows, notes);
    const rows = await applyOnTeeFallback(page, compactRowsForDashboard(rowsWithMinGolfFallback), courses, notes);
    await writeDiscovery(discoveryPath, { rows, captured, notes, from, to, apiSamples });

    if (!rows.length) {
      console.log(`Logged in, but no recognizable price rows were found. Discovery saved to ${relative(discoveryPath)}.`);
      console.log("Open that discovery file and I can tune the scraper to Min Golf's current booking API shape.");
      process.exitCode = 2;
    } else {
      await writeCsv(outputPath, rows);
      console.log(`Wrote ${rows.length} Min Golf price rows to ${relative(outputPath)}.`);
    }
  }
} finally {
  await browser.close();
}

async function loadEnv(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return [];
      const index = trimmed.indexOf("=");
      if (index === -1) return [];
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return [[key, value]];
    }));
  } catch {
    if ((process.env.MINGOLF_USERNAME || process.env.MINGOLF_GOLF_ID || process.env.MINGOLF_EMAIL) && process.env.MINGOLF_PASSWORD) {
      return {};
    }
    const typoCandidates = [".evn.local", ".evn.local.txt", ".env.local.txt"];
    const typo = await firstExisting(typoCandidates.map((name) => path.join(root, name)));
    const hint = typo ? ` I found \`${path.basename(typo)}\`; rename it to \`.env.local\` and add the keys there.` : "";
    throw new Error(`Missing .env.local.${hint} Use .env.local.example as the template.`);
  }
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const home = process.env.USERPROFILE || process.env.HOME;
    const packageJsonCandidates = home ? [
      path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", ".pnpm", "playwright@1.61.1", "node_modules", "playwright", "package.json"),
      path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright", "package.json"),
    ] : [];
    const packageJson = await firstExisting(packageJsonCandidates);
    if (packageJson) {
      const required = createRequire(packageJson)("playwright");
      return required.default || required;
    }
    throw new Error("Playwright is not installed. Use the bundled Codex runner or install project dependencies before running the fetcher.");
  }
}

async function findSystemChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return firstExisting(candidates);
}

function validateSecrets({ username, password, days }) {
  const missing = [];
  if (!username) missing.push("MINGOLF_USERNAME");
  if (!password) missing.push("MINGOLF_PASSWORD");
  if (missing.length) {
    throw new Error(`Missing ${missing.join(" and ")} in .env.local.`);
  }
  if (!Number.isInteger(days) || days < 1 || days > 120) {
    throw new Error("MINGOLF_DAYS must be an integer between 1 and 120.");
  }
}

async function login(page, username, password) {
  await logStep("Opening login page");
  await page.goto("https://mingolf.golf.se/login/?redirectUri=%2Fstart%2F", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await dismissCookieDialog(page);
  await clickIfVisible(page, /logga in/i);

  const userInput = await firstUsableLocator(page, [
    "input[type='email']",
    "input[name*='user' i]",
    "input[name*='email' i]",
    "input[name*='golf' i]",
    "input[id*='user' i]",
    "input[id*='email' i]",
    "input[id*='golf' i]",
    "input[placeholder*='Golf' i]",
    "input[type='tel']",
    "input:not([type])",
    "input[type='text']",
  ]);
  const passwordInput = await firstUsableLocator(page, [
    "input[type='password']",
    "input[name*='password' i]",
    "input[id*='password' i]",
  ]);

  if (!userInput || !passwordInput) {
    await saveLoginDebug(page);
    await savePageSnapshot(page, "login-form-not-found");
    throw new Error("Could not find Min Golf login inputs. A page snapshot was saved in tmp/mingolf/.");
  }

  await userInput.fill(username);
  await passwordInput.fill(password);
  await logStep("Submitting login form");
  await submitLogin(page, passwordInput);

  if (/\/login/i.test(page.url())) {
    await saveSanitizedLoginStatus(page, "still-on-login", authEvents);
    throw new Error("Login did not leave the login page. Check the credentials or whether Min Golf requires an interactive challenge.");
  }
}

async function submitLogin(page, passwordInput) {
  const loginButton = page.locator("button").filter({ hasText: /^Logga in$/ }).first();
  await Promise.race([
    page.waitForURL((url) => !/\/login/i.test(url.pathname), { timeout: 45000 }).catch(() => null),
    (async () => {
      await passwordInput.press("Enter").catch(() => {});
      await page.waitForTimeout(1500);
      if (/\/login/i.test(page.url()) && await loginButton.isVisible().catch(() => false)) {
        await loginButton.click();
      }
      await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {});
    })(),
  ]);
  await page.waitForTimeout(1500);
}

async function dismissCookieDialog(page) {
  const buttons = [
    /endast nödvändiga cookies/i,
    /endast nodvandiga cookies/i,
    /tillåt urval/i,
    /tillat urval/i,
    /accept necessary/i,
  ];
  for (const pattern of buttons) {
    if (await clickIfVisible(page, pattern)) {
      await page.waitForTimeout(700);
      return;
    }
  }
}

async function openBooking(page, notes) {
  const routes = [
    "https://mingolf.golf.se/bokning/",
    "https://mingolf.golf.se/start/bokning/",
    "https://mingolf.golf.se/booking/",
  ];

  for (const route of routes) {
    try {
      await logStep(`Opening ${route}`);
      console.log(`Opening ${route}`);
      await page.goto(route, { waitUntil: "commit", timeout: 20000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      if (!/404|not found/i.test(await page.title())) {
        await logStep(`Opened booking route: ${page.url()}`);
        console.log(`Opened booking route: ${page.url()}`);
        return;
      }
    } catch (error) {
      notes.push(`Route failed: ${route} (${error.message})`);
    }
  }

  const clicked = await clickIfVisible(page, /boka|starttid|tidbokning|tee time/i);
  if (!clicked) {
    notes.push("Could not identify a booking navigation item; continuing from current page.");
  }
}

async function discoverBookingAssets(page) {
  const scriptUrls = await page.locator("script[src]").evaluateAll((scripts) => scripts.map((script) => script.src));
  const assets = [];
  for (const url of scriptUrls.filter((src) => src.includes("bokning") || src.includes("static") || src.includes("js"))) {
    try {
      const response = await page.request.get(url, { timeout: 20000 });
      const text = await response.text();
      if (/\/bokning\/assets\/index-.*\.js/.test(url)) {
        await fs.mkdir(path.join(root, "tmp", "mingolf"), { recursive: true });
        await fs.writeFile(path.join(root, "tmp", "mingolf", "booking-index.js"), text, "utf8");
      }
      const endpoints = [...new Set([...text.matchAll(/["'`](\/bokning\/api\/[^"'`\\\s)]+)/g)].map((match) => match[1]))].sort();
      const apiWords = [...new Set([...text.matchAll(/\b[A-Za-z]+(?:Tee|Time|Booking|GreenFee|Slot|Course|Club|Reservation)[A-Za-z]*\b/g)].map((match) => match[0]))].slice(0, 80);
      if (endpoints.length || apiWords.length) {
        assets.push({ url, endpoints, apiWords });
      }
    } catch (error) {
      assets.push({ url, error: error.message });
    }
  }
  return assets;
}

async function logStep(message) {
  await fs.mkdir(path.dirname(runLogPath), { recursive: true });
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await fs.appendFile(runLogPath, line, "utf8");
}

async function searchCourse(page, course, from, to, notes) {
  const searchText = course.search;
  await clickIfVisible(page, /boka|sök|starttid|klubb/i);

  const input = await firstUsableLocator(page, [
    "input[type='search']",
    "input[placeholder*='klubb' i]",
    "input[placeholder*='bana' i]",
    "input[placeholder*='sök' i]",
    "input:not([type])",
    "input[type='text']",
  ]);

  if (!input) {
    notes.push(`No course search input found for ${course.course_id}.`);
    return;
  }

  await input.fill(searchText);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await clickIfVisible(page, new RegExp(escapeRegExp(searchText.split(" ")[0]), "i"));

  await fillDateLike(page, from, /från|start|datum/i);
  await fillDateLike(page, to, /till|slut/i);
  await clickIfVisible(page, /sök|visa|hämta|lediga/i);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function fetchRowsFromBookingApi(page, coursesToFetch, from, to, notes) {
  const overviewUrl = "/bokning/api/Clubs/Courses/StartTimes/Overview";
  const overview = await requestJson(page, overviewUrl);
  const clubs = overview?.clubs || [];
  if (!clubs.length) {
    notes.push("Booking API overview did not include clubs.");
    return [];
  }

  const rows = [];
  for (const dashboardCourse of coursesToFetch) {
    const club = findClub(clubs, dashboardCourse);
    if (!club) {
      notes.push(`No Min Golf club match found for ${dashboardCourse.course_id}.`);
      continue;
    }
    const allClubCourses = (club.courses || []).filter((course) => course?.id);
    const eighteenHoleCourses = selectEighteenHoleCourses(allClubCourses);
    const clubCourses = selectConfiguredCourses(eighteenHoleCourses, dashboardCourse, notes);
    if (!clubCourses.length) {
      notes.push(`No Min Golf courses found for ${dashboardCourse.course_id}.`);
      continue;
    }
    console.log(`API ${dashboardCourse.course_id}: ${club.name} (${clubCourses.length}/${allClubCourses.length} selected 18-hole course(s))`);
    for (const course of clubCourses) {
      const dates = [];
      for (let date = new Date(from); date <= to; date = addDays(date, 1)) dates.push(new Date(date));
      const courseRows = await mapLimit(dates, concurrency, async (date) => {
        const dateText = isoDate(date);
        const basePath = course.bookableViaSweetspot ? "/bokning/api/Sweetspot/Clubs" : "/bokning/api/Clubs";
        const schedulePath = `${basePath}/${encodeURIComponent(club.id)}/CourseSchedule?courseId=${encodeURIComponent(course.id)}&date=${dateText}`;
        const schedule = await requestJson(page, schedulePath).catch((error) => {
          notes.push(`Schedule failed for ${dashboardCourse.course_id} ${dateText}: ${error.message}`);
          return null;
        });
        if (!schedule) return [];
        if (apiSamples.length < 12) {
          apiSamples.push({
            dashboardCourse: dashboardCourse.course_id,
            club: club.name,
            course: course.name,
            date: dateText,
            url: `https://mingolf.golf.se${schedulePath}`,
            sample: compactSample(schedule),
          });
        }
        return extractScheduleRows(schedule, {
          courseId: dashboardCourse.course_id,
          courseName: course.name || schedule.courseName || "",
          clubId: club.id,
          minGolfCourseId: course.id,
          date: dateText,
          sourceUrl: "https://mingolf.golf.se/bokning/#/",
        });
      });
      rows.push(...courseRows.flat());
    }
  }
  return dedupeRows(rows).sort((a, b) => a.course_id.localeCompare(b.course_id) || a.date.localeCompare(b.date) || a.price - b.price);
}

async function requestJson(page, apiPath) {
  const url = new URL(apiPath, "https://mingolf.golf.se").toString();
  const response = await page.request.get(url, {
    headers: { accept: "application/json" },
    timeout: 30000,
  });
  if (!response.ok()) {
    throw new Error(`${response.status()} ${response.statusText()} for ${apiPath}`);
  }
  return response.json();
}

function findClub(clubs, dashboardCourse) {
  const candidates = [
    dashboardCourse.minGolfName,
    dashboardCourse.search,
    dashboardCourse.name,
  ].filter(Boolean).map(normalize);
  const idSearch = normalize(dashboardCourse.course_id);
  return clubs.find((club) => candidates.some((candidate) => normalize(club.name) === candidate))
    || clubs.find((club) => candidates.some((candidate) => normalize(club.name).includes(candidate)))
    || clubs.find((club) => normalize(club.name).includes(idSearch.replace(/-/g, " ")));
}

function selectEighteenHoleCourses(courses) {
  if (courses.length <= 1) return courses;
  const explicit = courses.filter((course) => {
    const holes = getCourseHoleCount(course);
    return holes === 18;
  });
  if (explicit.length) return explicit;

  const inferred = courses.filter((course) => !looksLikeNonEighteenHoleCourse(course));
  return inferred.length ? inferred : courses;
}

function selectConfiguredCourses(courses, dashboardCourse, notes) {
  const preferredName = dashboardCourse.courseName || dashboardCourse.minGolfCourseName;
  if (!preferredName) return courses;
  const preferred = normalizeCourseName(preferredName);
  const matches = courses.filter((course) => {
    const courseName = normalizeCourseName(`${course.name || ""} ${course.courseName || ""}`);
    return courseName === preferred || courseName.includes(preferred) || preferred.includes(courseName);
  });
  if (matches.length) return matches;
  notes.push(`Configured course "${preferredName}" was not found for ${dashboardCourse.course_id}; using all selected 18-hole courses.`);
  return courses;
}

function getCourseHoleCount(course) {
  const candidates = [
    course.holes,
    course.numberOfHoles,
    course.noOfHoles,
    course.holeCount,
    course.holesCount,
    course.courseHoles,
  ];
  for (const value of candidates) {
    const number = Number(String(value ?? "").replace(/[^\d]/g, ""));
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function looksLikeNonEighteenHoleCourse(course) {
  const name = normalize(`${course.name || ""} ${course.courseName || ""} ${course.type || ""} ${course.courseType || ""}`);
  return /\b(9|nio)\b/.test(name)
    || name.includes("korthal")
    || name.includes("kort bana")
    || name.includes("short")
    || name.includes("academy")
    || name.includes("par 3")
    || name.includes("pay and play");
}

function normalizeCourseName(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, "");
}

function extractScheduleRows(schedule, context) {
  if (Array.isArray(schedule?.slots)) {
    const rows = schedule.slots.flatMap((slot) => {
      const availability = slot.availablity || slot.availability || {};
      const availableSlots = Number(availability.availableSlots ?? availability.availableSlotCount ?? 0);
      const isBookable = availability.bookable !== false && availableSlots > 0 && !slot.isLocked;
      if (!isBookable) return [];
      const price = pickNumberDeep(slot, ["price", "greenfee", "greenFee", "amount", "fee", "cost"]);
      return [{
        course_id: context.courseId,
        date: context.date,
        price: Number.isFinite(price) ? price : "",
        course_name: context.courseName || schedule.courseName || "",
        currency: "SEK",
        tee_time: normalizeTime(slot.time || slot.startTime || ""),
        holes: pickNumberDeep(slot, ["holes", "numberOfHoles"]) || 18,
        source_url: context.sourceUrl,
        note: Number.isFinite(price) ? "Fetched from authenticated Min Golf booking API" : "Bookable in Min Golf; price not exposed until booking flow",
        slot_id: slot.id || "",
        club_id: context.clubId || schedule.clubId || "",
        min_golf_course_id: context.minGolfCourseId || schedule.courseId || "",
      }];
    });
    const pricedRows = rows.filter((row) => Number.isFinite(row.price));
    if (pricedRows.length) return pricedRows;
    return rows.sort((a, b) => a.tee_time.localeCompare(b.tee_time));
  }

  const objects = flattenObjects(schedule);
  return objects.flatMap((object) => {
    const price = pickNumberDeep(object, ["price", "greenfee", "greenFee", "amount", "fee", "cost"]);
    if (!Number.isFinite(price)) return [];
    const teeTime = pickString(object, ["startTime", "starttid", "teeTime", "time", "from"]) || pickStringDeep(object, ["startTime", "starttid", "teeTime", "time", "from"]) || "";
    const holes = pickNumberDeep(object, ["holes", "numberOfHoles"]) || "";
    return [{
      course_id: context.courseId,
      date: context.date,
      price,
      course_name: context.courseName || schedule.courseName || "",
      currency: pickStringDeep(object, ["currency", "currencyCode"]) || "SEK",
      tee_time: normalizeTime(teeTime),
      holes,
      source_url: context.sourceUrl,
      note: "Fetched from authenticated Min Golf booking API",
    }];
  });
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactRowsForDashboard(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const key = `${row.course_id}|${row.date}`;
    const current = byDay.get(key);
    if (!current || isBetterOutputRow(row, current)) byDay.set(key, row);
  }
  return [...byDay.values()];
}

function isBetterOutputRow(candidate, current) {
  const candidateHasPrice = Number.isFinite(candidate.price);
  const currentHasPrice = Number.isFinite(current.price);
  if (candidateHasPrice && !currentHasPrice) return true;
  if (!candidateHasPrice && currentHasPrice) return false;
  if (candidateHasPrice && currentHasPrice) {
    return candidate.price < current.price || (candidate.price === current.price && String(candidate.tee_time).localeCompare(String(current.tee_time)) < 0);
  }
  return String(candidate.tee_time).localeCompare(String(current.tee_time)) < 0;
}

async function applyMinGolfBookingPriceFallback(page, rows, notes) {
  const pricedKeys = new Set(rows
    .filter((row) => Number.isFinite(row.price))
    .map((row) => `${row.course_id}|${row.date}`));
  const hiddenCandidates = rows.filter((row) =>
    !Number.isFinite(row.price)
    && !pricedKeys.has(`${row.course_id}|${row.date}`)
    && row.slot_id
    && row.club_id
    && row.min_golf_course_id
    && timeToMinutes(row.tee_time) >= hiddenPriceStartHour * 60
  );
  if (!hiddenCandidates.length) return rows;

  const byDay = new Map();
  for (const row of hiddenCandidates) {
    const key = `${row.course_id}|${row.date}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }

  let profile;
  try {
    profile = await requestJson(page, "/login/api/profile");
  } catch (error) {
    notes.push(`Min Golf booking-price fallback unavailable: ${error.message}`);
    return rows;
  }

  const player = buildMinGolfPlayer(profile);
  if (!player.hashId) {
    notes.push("Min Golf booking-price fallback unavailable: profile did not include a usable player id.");
    return rows;
  }

  console.log(`Min Golf hidden-price fallback: probing ${byDay.size} course-day(s) after ${String(hiddenPriceStartHour).padStart(2, "0")}:00.`);
  const pricedRows = [];
  const groups = [...byDay.values()].map((group) => selectHiddenPriceProbeRows(group));
  await mapLimit(groups, hiddenPriceConcurrency, async (group) => {
    const testedRows = [];
    for (const row of group) {
      const price = await fetchDraftBookingPrice(page, row, player, notes);
      if (!Number.isFinite(price)) continue;
      testedRows.push({
        ...row,
        price,
        currency: "SEK",
        note: `Fetched from Min Golf booking validation for tee times after ${String(hiddenPriceStartHour).padStart(2, "0")}:00`,
      });
    }
    const best = compactRowsForDashboard(testedRows)[0];
    if (best) pricedRows.push(best);
  });

  notes.push(`Min Golf booking-price fallback priced ${pricedRows.length}/${byDay.size} hidden course-day(s).`);
  return pricedRows.length ? rows.concat(pricedRows) : rows;
}

async function fetchDraftBookingPrice(page, row, player, notes) {
  const slotBookingId = `new_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const payload = [{
    slotBookingId,
    state: "Added",
    hasBeenValidated: false,
    player,
    isNineHole: false,
    hasArrived: false,
  }];

  try {
    const validation = await postJson(page, `/bokning/api/Slot/${encodeURIComponent(row.slot_id)}/Bookings/Validate`, payload);
    return pickDraftBookingPrice(validation, slotBookingId);
  } catch (error) {
    notes.push(`Min Golf booking-price fallback failed for ${row.course_id} ${row.date} ${row.tee_time}: ${error.message}`);
    return null;
  }
}

async function postJson(page, apiPath, body) {
  const url = new URL(apiPath, "https://mingolf.golf.se").toString();
  const response = await page.request.post(url, {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    data: body,
    timeout: 30000,
  });
  if (!response.ok()) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status()} ${response.statusText()} for ${apiPath}${text ? `: ${text.slice(0, 180)}` : ""}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function buildMinGolfPlayer(profile) {
  const player = {
    personId: profile.personId || undefined,
    golfId: profile.golfId,
    firstName: profile.firstName,
    lastName: profile.lastName,
    fullName: `${profile.firstName || ""} ${profile.lastName || ""}`.trim(),
    hcp: profile.hcp,
    age: Number.parseInt(profile.age, 10),
    gender: profile.gender,
    isBooker: true,
    homeClub: profile.homeClubName,
    foreignId: profile.foreignId,
    isGuest: false,
  };
  player.hashId = player.foreignId || (!player.personId && player.golfId ? player.golfId : player.personId);
  return player;
}

function pickDraftBookingPrice(validation, slotBookingId) {
  const engagement = (validation?.engagementInformation || []).find((item) => !slotBookingId || item.slotBookingId === slotBookingId)
    || validation?.engagementInformation?.[0];
  if (!engagement) return null;

  const preferred = [];
  const fallback = [];
  for (const object of flattenObjects(engagement)) {
    const amount = pickNumber(object, ["amountToPay"]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const label = normalize(`${object.articleType || ""} ${object.articleName || ""} ${object.name || ""}`);
    if (label.includes("greenfee") || label.includes("prebookingfee") || label.includes("forbokningsavgift")) {
      preferred.push(amount);
    } else {
      fallback.push(amount);
    }
  }
  const prices = preferred.length ? preferred : fallback;
  return prices.length ? Math.min(...prices) : null;
}

function timeToMinutes(value) {
  const match = String(value || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return -1;
  return Number(match[1]) * 60 + Number(match[2]);
}

function selectHiddenPriceProbeRows(group) {
  const sorted = [...group].sort((a, b) => a.tee_time.localeCompare(b.tee_time));
  if (sorted.length <= hiddenPriceMaxSlotsPerDay) return sorted;
  if (hiddenPriceMaxSlotsPerDay === 1) return [sorted.at(-1)];
  const selected = new Map();
  const add = (row) => selected.set(row.slot_id || `${row.date}-${row.tee_time}`, row);
  add(sorted[0]);
  sorted.slice(-(hiddenPriceMaxSlotsPerDay - 1)).forEach(add);
  return [...selected.values()].sort((a, b) => a.tee_time.localeCompare(b.tee_time));
}

async function applyOnTeeFallback(page, rows, coursesToFetch, notes) {
  const hiddenRows = rows.filter((row) => !Number.isFinite(row.price));
  if (!hiddenRows.length) return rows;

  const activeClubs = await requestOnTeeJson(page, "v2/GolfClubs/Active", {}).catch((error) => {
    notes.push(`OnTee fallback unavailable: ${error.message}`);
    return [];
  });
  if (!Array.isArray(activeClubs) || !activeClubs.length) return rows;

  const coursesById = new Map(coursesToFetch.map((course) => [course.course_id, course]));
  const matchesByCourseId = new Map();
  const unmatchedCourseIds = new Set();
  for (const row of hiddenRows) {
    if (matchesByCourseId.has(row.course_id) || unmatchedCourseIds.has(row.course_id)) continue;
    const dashboardCourse = coursesById.get(row.course_id);
    const match = dashboardCourse ? findOnTeeMatch(activeClubs, dashboardCourse) : null;
    if (match) {
      matchesByCourseId.set(row.course_id, match);
    } else {
      unmatchedCourseIds.add(row.course_id);
      notes.push(`OnTee fallback: no active 18-hole course match for ${row.course_id}.`);
    }
  }

  if (!matchesByCourseId.size) return rows;

  const fallbackByKey = new Map();
  for (const row of hiddenRows) {
    const match = matchesByCourseId.get(row.course_id);
    if (!match) continue;
    const onTeeRows = [];
    for (const course of match.courses) {
      const availability = await requestOnTeeJson(page, "v2/bookings/available", {
        golfCourseId: course.id,
        startTime: `${row.date} 00:00:00`,
        endTime: `${row.date} 23:59:59`,
      }).catch((error) => {
        notes.push(`OnTee fallback failed for ${row.course_id} ${row.date}: ${error.message}`);
        return null;
      });
      if (!availability) continue;
      onTeeRows.push(...extractOnTeeAvailabilityRows(availability, {
        courseId: row.course_id,
        courseName: course.name || row.course_name || "",
        date: row.date,
        holes: getCourseHoleCount(course) || row.holes || 18,
        sourceUrl: `https://www.ontee.com/en/booking/${encodeURIComponent(match.club.id)}/${encodeURIComponent(course.id)}`,
      }));
    }
    const best = compactRowsForDashboard(onTeeRows)[0];
    if (best && Number.isFinite(best.price)) fallbackByKey.set(`${row.course_id}|${row.date}`, best);
  }

  if (!fallbackByKey.size) return rows;
  return rows.map((row) => fallbackByKey.get(`${row.course_id}|${row.date}`) || row);
}

async function requestOnTeeJson(page, apiPath, params) {
  const url = new URL(apiPath, "https://api.ontee.com/");
  Object.entries({
    ...params,
    lang: "en",
    isGHRequest: "false",
  }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  const response = await page.request.get(url.toString(), {
    headers: { accept: "application/json" },
    timeout: 30000,
  });
  if (!response.ok()) {
    throw new Error(`${response.status()} ${response.statusText()} for ${apiPath}`);
  }
  return response.json();
}

function findOnTeeMatch(activeClubs, dashboardCourse) {
  const candidates = [
    dashboardCourse.onTeeName,
    dashboardCourse.minGolfName,
    dashboardCourse.search,
    dashboardCourse.name,
    dashboardCourse.course_id,
  ].filter(Boolean).map(normalizeClubName).filter(Boolean);

  const club = activeClubs.find((candidate) => {
    const clubName = normalizeClubName(candidate.name);
    return candidates.some((name) => clubName === name);
  }) || activeClubs.find((candidate) => {
    const clubName = normalizeClubName(candidate.name);
    return candidates.some((name) => name.length >= 8 && (clubName.includes(name) || name.includes(clubName)));
  });

  if (!club) return null;
  const courses = selectEighteenHoleCourses((club.golfCourses || []).filter((course) => course?.id));
  if (!courses.length) return null;
  return { club, courses };
}

function extractOnTeeAvailabilityRows(availability, context) {
  return flattenObjects(availability).flatMap((object) => {
    const price = pickLikelyPrice(object);
    if (!Number.isFinite(price)) return [];
    const teeTime = pickString(object, ["startTime", "teeTime", "time", "from"])
      || pickStringDeep(object, ["startTime", "teeTime", "time", "from"])
      || "";
    return [{
      course_id: context.courseId,
      course_name: context.courseName,
      date: context.date,
      price,
      currency: pickStringDeep(object, ["currency", "currencyCode"]) || "SEK",
      tee_time: normalizeTime(teeTime),
      holes: context.holes,
      source_url: context.sourceUrl,
      note: "Fetched from OnTee fallback because Min Golf hid the price",
    }];
  });
}

function pickLikelyPrice(value) {
  if (!value || typeof value !== "object") return null;
  const prices = [];
  collectLikelyPrices(value, prices);
  return prices.length ? Math.min(...prices) : null;
}

function collectLikelyPrices(value, output) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectLikelyPrices(item, output));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      /(price|greenfee|amount|cost|fee)/.test(normalizedKey)
      && !/(count|id|holes|number|percentage|percent|vat|tax)/.test(normalizedKey)
    ) {
      const number = Number(String(child).replace(/[^\d.,-]/g, "").replace(",", "."));
      if (Number.isFinite(number) && number > 0 && number < 10000) output.push(Math.round(number));
    }
    collectLikelyPrices(child, output);
  }
}

function normalizeClubName(value) {
  return normalize(value)
    .replace(/&/g, " and ")
    .replace(/\bgolf\s*(club|klubb|course|country club)\b/g, "gk")
    .replace(/\bgolfklubb\b/g, "gk")
    .replace(/\bgolfclub\b/g, "gk")
    .replace(/\b(golf|club|klubb|country|course|and)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function firstUsableLocator(page, selectors) {
  for (const selector of selectors) {
    const locators = await page.locator(selector).all();
    for (const locator of locators) {
      if (await locator.isVisible().catch(() => false)) return locator;
    }
  }
  return null;
}

async function clickIfVisible(page, namePattern) {
  const candidates = [
    page.getByRole("button", { name: namePattern }),
    page.getByRole("link", { name: namePattern }),
    page.getByText(namePattern).first(),
  ];
  for (const locator of candidates) {
    const first = locator.first();
    if (await first.isVisible().catch(() => false)) {
      try {
        await first.click();
      } catch {
        continue;
      }
      return true;
    }
  }
  return false;
}

async function fillDateLike(page, date, labelPattern) {
  const value = isoDate(date);
  const inputs = await page.locator("input").all();
  for (const input of inputs) {
    const visible = await input.isVisible().catch(() => false);
    if (!visible) continue;
    const attrs = `${await input.getAttribute("aria-label").catch(() => "")} ${await input.getAttribute("placeholder").catch(() => "")} ${await input.getAttribute("name").catch(() => "")}`;
    const type = await input.getAttribute("type").catch(() => "");
    if (type === "date" || labelPattern.test(attrs)) {
      await input.fill(value).catch(() => {});
      return;
    }
  }
}

function extractRows(capturedResponses, courses, from, to) {
  const courseByNeedle = courses.map((course) => ({
    ...course,
    needles: [course.course_id, course.search, course.search.replace(/ Golf(klubb| Club)?/i, "")].map(normalize),
  }));
  const rows = [];
  const seen = new Set();

  for (const response of capturedResponses) {
    for (const item of flattenObjects(response.body)) {
      const text = normalize(JSON.stringify(item));
      const course = courseByNeedle.find((candidate) => candidate.needles.some((needle) => needle && text.includes(needle)));
      if (!course) continue;

      const price = pickNumber(item, ["price", "greenfee", "greenFee", "amount", "fee", "cost", "totalPrice"]);
      const date = pickDate(item);
      if (!Number.isFinite(price) || !date || date < from || date > to) continue;

      const teeTime = pickString(item, ["time", "teeTime", "startTime", "starttid", "slotTime"]) || "";
      const holes = pickNumber(item, ["holes", "numberOfHoles"]) || "";
      const row = {
        course_id: course.course_id,
        date: isoDate(date),
        price,
        currency: pickString(item, ["currency", "currencyCode"]) || "SEK",
        tee_time: teeTime.slice(0, 5),
        holes,
        source_url: response.url,
        note: "Fetched from authenticated Min Golf session",
      };
      const key = Object.values(row).join("|");
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    }
  }

  return rows.sort((a, b) => a.course_id.localeCompare(b.course_id) || a.date.localeCompare(b.date) || a.price - b.price);
}

function flattenObjects(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item) => flattenObjects(item, output));
    return output;
  }
  output.push(value);
  Object.values(value).forEach((item) => flattenObjects(item, output));
  return output;
}

function pickNumber(object, names) {
  for (const [key, value] of Object.entries(object)) {
    if (!names.some((name) => key.toLowerCase().includes(name.toLowerCase()))) continue;
    const number = Number(String(value).replace(/[^\d.,-]/g, "").replace(",", "."));
    if (Number.isFinite(number) && number > 0) return Math.round(number);
  }
  return null;
}

function pickString(object, names) {
  for (const [key, value] of Object.entries(object)) {
    if (value == null || typeof value === "object") continue;
    if (names.some((name) => key.toLowerCase().includes(name.toLowerCase()))) return String(value);
  }
  return null;
}

function pickNumberDeep(value, names) {
  if (!value || typeof value !== "object") return null;
  const direct = pickNumber(value, names);
  if (Number.isFinite(direct)) return direct;
  for (const child of Object.values(value)) {
    const found = pickNumberDeep(child, names);
    if (Number.isFinite(found)) return found;
  }
  return null;
}

function pickStringDeep(value, names) {
  if (!value || typeof value !== "object") return null;
  const direct = pickString(value, names);
  if (direct) return direct;
  for (const child of Object.values(value)) {
    const found = pickStringDeep(child, names);
    if (found) return found;
  }
  return null;
}

function normalizeTime(value) {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Stockholm",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
    }
  }
  const match = text.match(/(?:^|[^\d])([01]?\d|2[0-3])[:.]([0-5]\d)(?:[^\d]|$)/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : "";
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      output[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return output;
}

function pickDate(object) {
  for (const [key, value] of Object.entries(object)) {
    if (value == null || typeof value === "object") continue;
    if (!/date|datum|day/i.test(key)) continue;
    const date = parseDate(String(value));
    if (date) return date;
  }
  for (const value of Object.values(object)) {
    if (typeof value !== "string") continue;
    const date = parseDate(value);
    if (date) return date;
  }
  return null;
}

function parseDate(value) {
  const iso = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const compact = value.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (compact) return new Date(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]));
  return null;
}

async function writeCsv(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const headers = ["course_id", "course_name", "date", "price", "currency", "tee_time", "holes", "source_url", "note"];
  const lines = [headers.join(",")].concat(rows.map((row) => headers.map((header) => csvCell(row[header] ?? "")).join(",")));
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function writeDiscovery(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const safePayload = {
    generated_at: new Date().toISOString(),
    date_window: {
      from: isoDate(payload.from),
      to: isoDate(payload.to),
    },
    recognized_rows: payload.rows.length,
    notes: payload.notes,
    api_samples: payload.apiSamples || [],
    responses: payload.captured.map((response) => ({
      url: response.url,
      status: response.status,
      method: response.method,
      sample: response.body,
    })).slice(0, 80),
  };
  await fs.writeFile(filePath, `${JSON.stringify(safePayload, null, 2)}\n`, "utf8");
}

function compactSample(value, depth = 0) {
  if (depth > 4) return "[max-depth]";
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => compactSample(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).slice(0, 25).map(([key, child]) => [key, compactSample(child, depth + 1)]));
}

async function savePageSnapshot(page, name) {
  const dir = path.join(root, "tmp", "mingolf");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.html`), await page.content(), "utf8");
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(() => {});
}

async function saveLoginDebug(page) {
  const dir = path.join(root, "tmp", "mingolf");
  await fs.mkdir(dir, { recursive: true });
  const debug = await page.evaluate(() => {
    const elements = [...document.querySelectorAll("input, textarea, select, button, a, [role], [contenteditable='true']")];
    return elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        type: element.getAttribute("type") || "",
        id: element.id || "",
        name: element.getAttribute("name") || "",
        placeholder: element.getAttribute("placeholder") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        text: (element.innerText || element.textContent || "").trim().slice(0, 120),
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    }).filter((element) => element.visible);
  });
  await fs.writeFile(path.join(dir, "login-debug.json"), `${JSON.stringify(debug, null, 2)}\n`, "utf8");
}

async function saveSanitizedLoginStatus(page, name, authResponses = []) {
  const dir = path.join(root, "tmp", "mingolf");
  await fs.mkdir(dir, { recursive: true });
  const status = await page.evaluate(() => {
    const textElements = [...document.querySelectorAll("body *")].filter((element) => {
      const tag = element.tagName.toLowerCase();
      if (["input", "textarea", "script", "style"].includes(tag)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const texts = textElements
      .map((element) => (element.innerText || element.textContent || "").trim())
      .filter(Boolean)
      .filter((text, index, array) => array.indexOf(text) === index)
      .slice(0, 80);
    return { url: location.href, title: document.title, texts };
  });
  status.authResponses = authResponses.slice(-20);
  await fs.writeFile(path.join(dir, `${name}.json`), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

function looksRelevant(text) {
  return /price|greenfee|fee|amount|starttid|tee|booking|bokning|golf|klubb|bana|datum|date/i.test(text);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 2000) };
  }
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(filePaths) {
  for (const filePath of filePaths) {
    if (await exists(filePath)) return filePath;
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}
