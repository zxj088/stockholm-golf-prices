const state = {
  courses: [],
  prices: [],
  currency: "SEK",
  loadError: "",
  windowStart: startOfDay(new Date()),
  windowDays: 60,
};

document.addEventListener("DOMContentLoaded", async () => {
  await loadData();
  render();
});

async function loadData() {
  try {
    const [courseResponse, priceResponse] = await Promise.all([
      fetch("data/courses.json"),
      fetch("data/prices.csv"),
    ]);
    if (!courseResponse.ok || !priceResponse.ok) {
      throw new Error("Data files unavailable");
    }
    const courseData = await courseResponse.json();
    state.courses = courseData.courses;
    state.currency = courseData.currency || "SEK";
    state.prices = parseCsv(await priceResponse.text());
  } catch (error) {
    state.courses = [];
    state.prices = [];
    state.loadError = error.message || "Data files unavailable";
    showNotice("Could not load data/courses.json and data/prices.csv. The scheduled scraper must publish these files before the dashboard can render prices.");
  }
}

function render() {
  const enriched = getEnrichedCourses();
  const sorted = sortCourses(enriched);
  renderMeta(enriched);
  renderRows(sorted);
}

function getEnrichedCourses() {
  const windowEnd = addDays(state.windowStart, state.windowDays);
  const rowsInWindow = state.prices.filter((price) => {
    const date = parseLocalDate(price.date);
    return date && date >= state.windowStart && date < windowEnd;
  });

  return state.courses.map((course) => {
    const availabilityRows = rowsInWindow.filter((price) => price.course_id === course.id);
    const coursePrices = availabilityRows
      .filter((price) => Number.isFinite(price.price))
      .sort(comparePriceRows);
    const cheapest = coursePrices[0] || null;
    const firstAvailable = availabilityRows.sort((a, b) => parseLocalDate(a.date) - parseLocalDate(b.date))[0] || null;
    return { ...course, prices: coursePrices, availabilityRows, cheapest, firstAvailable };
  });
}

function sortCourses(courses) {
  return [...courses].sort((a, b) => {
    const aPrice = a.cheapest ? a.cheapest.price : Number.POSITIVE_INFINITY;
    const bPrice = b.cheapest ? b.cheapest.price : Number.POSITIVE_INFINITY;
    return aPrice - bPrice || a.rank - b.rank;
  });
}

function renderMeta(courses) {
  const priced = courses.filter((course) => course.cheapest);
  const rowsInWindow = courses.reduce((sum, course) => sum + course.availabilityRows.length, 0);
  const best = priced.reduce((winner, course) => {
    if (!winner) return course.cheapest;
    return course.cheapest.price < winner.price ? course.cheapest : winner;
  }, null);
  const endDate = addDays(state.windowStart, state.windowDays - 1);

  setText("#dateRange", `${formatDate(state.windowStart)} to ${formatDate(endDate)}`);
  setText("#dataQuality", state.loadError ? "Data unavailable" : "update at 21:00 everyday");
  setText("#courseCount", courses.length);
  setText("#pricedCount", priced.length);
  setText("#rowCount", rowsInWindow);
  setText("#bestPrice", best ? formatPrice(best.price, best.currency || state.currency) : "-");
}

function renderRows(courses) {
  const tbody = document.querySelector("#courseRows");
  tbody.innerHTML = "";
  if (!courses.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="8" class="missing">${state.loadError ? "Price data is unavailable." : "No courses found."}</td>`;
    tbody.appendChild(row);
    return;
  }

  courses.forEach((course) => {
    const row = document.createElement("tr");
    const priceHtml = course.cheapest
      ? `<span class="price">${formatPrice(course.cheapest.price, course.cheapest.currency || state.currency)}</span>`
      : course.firstAvailable
        ? `<span class="missing">Price hidden</span>`
      : `<span class="missing">No row</span>`;
    const sourceUrl = getOpenUrl(course.cheapest?.source_url || course.firstAvailable?.source_url || course.bookingUrl || course.website);
    const selectedCourseName = course.cheapest?.course_name || course.firstAvailable?.course_name || "";

    row.innerHTML = `
      <td>
        <div class="courseName">
          <strong>${escapeHtml(course.name)}</strong>
          <span>${escapeHtml(selectedCourseName || `Guide #${course.rank}`)}</span>
        </div>
      </td>
      <td>${escapeHtml(course.area || "-")}</td>
      <td>${priceHtml}</td>
      <td>${course.cheapest ? formatDate(parseLocalDate(course.cheapest.date)) : course.firstAvailable ? formatDate(parseLocalDate(course.firstAvailable.date)) : "-"}</td>
      <td>${escapeHtml(course.cheapest?.tee_time || course.firstAvailable?.tee_time || "-")}</td>
      <td>${escapeHtml(course.cheapest?.holes || course.firstAvailable?.holes || "-")}</td>
      <td>
        <div class="sourceLinks">
          <a href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noreferrer">Open</a>
        </div>
      </td>
      <td>${renderHeat(course.availabilityRows)}</td>
    `;
    tbody.appendChild(row);
  });
}

function renderHeat(prices) {
  const bestByDay = new Map();
  prices.forEach((price) => {
    const key = price.date;
    const current = bestByDay.get(key);
    if (!current || isBetterDayRow(price, current)) bestByDay.set(key, price);
  });

  const values = [...bestByDay.values()].map((row) => row.price).filter(Number.isFinite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const cells = [];
  for (let index = 0; index < state.windowDays; index += 4) {
    const date = addDays(state.windowStart, index);
    const key = isoDate(date);
    const row = bestByDay.get(key);
    const level = row ? (Number.isFinite(row.price) ? priceLevel(row.price, min, max) : 1) : 0;
    const label = row ? `${formatDate(date)}: ${Number.isFinite(row.price) ? formatPrice(row.price, row.currency || state.currency) : "bookable, price hidden"}` : `${formatDate(date)}: no row`;
    cells.push(`<span data-level="${level}" title="${escapeAttribute(label)}"></span>`);
  }
  return `<div class="heat" aria-label="Price availability over the next 60 days">${cells.join("")}</div>`;
}

function isBetterDayRow(candidate, current) {
  const candidateHasPrice = Number.isFinite(candidate.price);
  const currentHasPrice = Number.isFinite(current.price);
  if (candidateHasPrice && !currentHasPrice) return true;
  if (!candidateHasPrice && currentHasPrice) return false;
  if (candidateHasPrice && currentHasPrice) return comparePriceRows(candidate, current) < 0;
  return compareTeeTime(candidate, current) < 0;
}

function comparePriceRows(a, b) {
  return a.price - b.price
    || parseLocalDate(a.date) - parseLocalDate(b.date)
    || compareTeeTime(a, b);
}

function compareTeeTime(a, b) {
  return String(a.tee_time || "99:99").localeCompare(String(b.tee_time || "99:99"));
}

function priceLevel(price, min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (min === max) return 2;
  const ratio = (price - min) / (max - min);
  if (ratio <= 0.25) return 3;
  if (ratio <= 0.55) return 2;
  if (ratio <= 0.8) return 1;
  return 4;
}

function parseCsv(csvText) {
  const rows = csvText.replace(/\r/g, "").split("\n").filter(Boolean);
  if (rows.length < 2) return [];
  const headers = splitCsvLine(rows[0]).map((header) => header.trim());
  return rows.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() || ""]));
    return {
      ...row,
      price: row.price === "" ? Number.NaN : Number(row.price),
    };
  }).filter((row) => row.course_id && row.date);
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseLocalDate(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(date) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(date);
}

function formatPrice(price, currency) {
  return new Intl.NumberFormat("sv-SE", {
    style: "currency",
    currency: currency || "SEK",
    maximumFractionDigits: 0,
  }).format(price);
}

function showNotice(message) {
  const notice = document.querySelector("#notice");
  notice.textContent = message;
  notice.hidden = false;
}

function getOpenUrl(url) {
  const value = String(url || "");
  if (value.includes("mingolf.golf.se/bokning/api/")) return "https://mingolf.golf.se/bokning/#/";
  return value;
}

function setText(selector, value) {
  document.querySelector(selector).textContent = value;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

