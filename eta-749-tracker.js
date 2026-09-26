const http = require('http');
const Adm = require('adm-zip');
const { FeedMessage } =
  require('gtfs-realtime-bindings').transit_realtime;

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH =
  process.env.HISTORY_DB_PATH ||
  path.join(__dirname, 'data', 'history.db');

fs.mkdirSync(
  path.dirname(DB_PATH),
  { recursive: true }
);

const historyDb =
  new Database(DB_PATH);

historyDb.exec(`
  CREATE TABLE IF NOT EXISTS passage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_date TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    route_id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL,
    license_plate TEXT,
    target_id TEXT NOT NULL,
    stop_id TEXT NOT NULL,
    scheduled_arrival TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS
    idx_passage_events_service_trip_target
  ON passage_events (
    service_date,
    trip_id,
    target_id
  );

  CREATE TABLE IF NOT EXISTS trip_departures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_date TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    route_id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    vehicle_id TEXT NOT NULL,
    license_plate TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS
    idx_trip_departures_service_trip
  ON trip_departures (
    service_date,
    trip_id
  );

  DROP VIEW IF EXISTS trip_times;

  CREATE VIEW trip_times AS
  SELECT
    p.service_date,
    p.route_id,
    p.trip_id,
    p.vehicle_id,
    p.license_plate,
    d.observed_at AS departure_at,
    p.target_id,
    p.observed_at AS passed_at,
    ROUND(
      (
        julianday(p.observed_at) -
        julianday(d.observed_at)
      ) * 86400
    ) AS travel_time_seconds
  FROM passage_events p
  JOIN trip_departures d
    ON d.service_date = p.service_date
   AND d.trip_id = p.trip_id;
`);

const insertPassageEvent =
  historyDb.prepare(`
    INSERT OR IGNORE INTO passage_events (
      service_date,
      observed_at,
      route_id,
      trip_id,
      vehicle_id,
      license_plate,
      target_id,
      stop_id,
      scheduled_arrival
    )
    VALUES (
      @serviceDate,
      @observedAt,
      @routeId,
      @tripId,
      @vehicleId,
      @licensePlate,
      @targetId,
      @stopId,
      @scheduledArrival
    )
  `);

const insertTripDeparture =
  historyDb.prepare(`
    INSERT OR IGNORE INTO trip_departures (
      service_date,
      observed_at,
      route_id,
      trip_id,
      vehicle_id,
      license_plate
    )
    VALUES (
      @serviceDate,
      @observedAt,
      @routeId,
      @tripId,
      @vehicleId,
      @licensePlate
    )
  `);

function saveTripDeparture(vehicle) {
  const observedAt =
    new Date(
      vehicle.timestamp * 1000
    );

  const serviceDate =
    observedAt
      .toLocaleDateString(
        'en-CA',
        {
          timeZone: 'Europe/Lisbon'
        }
      );

  insertTripDeparture.run({
    serviceDate,

    observedAt:
      observedAt.toISOString(),

    routeId:
      vehicle.routeId,

    tripId:
      vehicle.tripId,

    vehicleId:
      vehicle.vehicleId,

    licensePlate:
      vehicle.licensePlate
  });
}


function getLisbonDateParts(isoTimestamp) {
  const date = new Date(isoTimestamp);

  const parts = new Intl.DateTimeFormat(
    'en-GB',
    {
      timeZone: 'Europe/Lisbon',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }
  ).formatToParts(date);

  const result = {};

  for (const part of parts) {
    result[part.type] = part.value;
  }

  return {
    weekday: result.weekday,
    time:
      `${result.hour}:${result.minute}:${result.second}`
  };
}

function isServiceActiveOnDate(
  serviceId,
  date,
  calendar,
  calendarDates
) {
  const dateString =
    date.toLocaleDateString(
      'en-CA',
      {
        timeZone:
          'Europe/Lisbon'
      }
    );

  const dateParts =
    dateString.split('-');

  const year =
    Number(dateParts[0]);

  const month =
    Number(dateParts[1]);

  const day =
    Number(dateParts[2]);

  const dateNumber =
    year * 10000 +
    month * 100 +
    day;

  const base =
    calendar.get(
      serviceId
    );

  let active =
    false;

  if (base) {
    const start =
      Number(base.startDate);

    const end =
      Number(base.endDate);

    if (
      dateNumber >= start &&
      dateNumber <= end
    ) {
      const weekday =
        date.getDay();

      const enabled =
        weekday === 0
          ? base.sunday
          : weekday === 1
            ? base.monday
            : weekday === 2
              ? base.tuesday
              : weekday === 3
                ? base.wednesday
                : weekday === 4
                  ? base.thursday
                  : weekday === 5
                    ? base.friday
                    : base.saturday;

      active =
        enabled;
    }
  }

  const exceptions =
    calendarDates.get(
      serviceId
    ) ?? [];

  const exception =
    exceptions.find(
      item =>
        item.date ===
        dateString.replace(
          /-/g,
          ''
        )
    );

  if (exception) {
    if (
      exception.exceptionType === 1
    ) {
      active = true;
    }

    if (
      exception.exceptionType === 2
    ) {
      active = false;
    }
  }

  return active;
}

function getNextScheduledTargetArrival(
  targetId,
  targetsByTrip,
  calendar,
  calendarDates,
  referenceDate = new Date(),
  lastPassed = null
) {
  const now =
    referenceDate;

  const localParts =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone:
          'Europe/Lisbon',

        year:
          'numeric',

        month:
          '2-digit',

        day:
          '2-digit',

        hour:
          '2-digit',

        minute:
          '2-digit',

        second:
          '2-digit',

        hourCycle:
          'h23'
      }
    ).formatToParts(now);

  const getPart =
    type =>
      localParts.find(
        part =>
          part.type === type
      )?.value;

  const currentHour =
    Number(
      getPart('hour')
    );

  const currentMinute =
    Number(
      getPart('minute')
    );

  const currentSecond =
    Number(
      getPart('second')
    );

  const currentSeconds =
    currentHour * 3600 +
    currentMinute * 60 +
    currentSecond;

  let nextTime =
    null;

  for (
    const targets
    of targetsByTrip.values()
  ) {
    for (
      const target
      of targets
    ) {
      if (
        target.targetId !==
        targetId ||
        !target.scheduledTargetArrivalTime
      ) {
        continue;
      }

      if (
        lastPassed &&
        lastPassed.tripId &&
        target.tripId ===
        lastPassed.tripId
      ) {
        continue;
      }

      if (
        !isServiceActiveOnDate(
          target.serviceId,
          now,
          calendar,
          calendarDates
        )
      ) {
        continue;
      }

      const parts =
        target.scheduledTargetArrivalTime
          .split(':');

      const scheduledSeconds =
        Number(parts[0]) * 3600 +
        Number(parts[1]) * 60 +
        Number(parts[2]);

      if (
        scheduledSeconds <=
        currentSeconds
      ) {
        continue;
      }

      if (
        nextTime === null ||
        scheduledSeconds <
        nextTime.seconds
      ) {
        nextTime = {
          seconds:
            scheduledSeconds,

          time:
            target.scheduledTargetArrivalTime
        };
      }
    }
  }

  return nextTime
    ? nextTime.time
    : null;
}

function getTravelTimeStats({
  targetId,
  startTime,
  endTime,
  dayType
}) {
  const trips =
    historyDb
      .prepare(`
        SELECT *
        FROM trip_times
        WHERE target_id = ?
      `)
      .all(targetId);

  const filteredTrips =
    trips.filter(trip => {
      const local =
        getLisbonDateParts(
          trip.departure_at
        );

      const isWeekday =
        !['Sat', 'Sun'].includes(
          local.weekday
        );

      const matchesDayType =
        dayType === 'weekday'
          ? isWeekday
          : dayType === 'weekend'
            ? !isWeekday
            : true;

      const matchesTime =
        local.time >= startTime &&
        local.time < endTime;

      return (
        matchesDayType &&
        matchesTime
      );
    });

  const validTrips =
    filteredTrips.filter(
      trip =>
        Number.isFinite(
          trip.travel_time_seconds
        ) &&
        trip.travel_time_seconds >= 0
    );

  if (!validTrips.length) {
    return {
      trips: 0,
      minSeconds: null,
      avgSeconds: null,
      maxSeconds: null,
      fastest: null
    };
  }

  const times =
    validTrips.map(
      trip =>
        trip.travel_time_seconds
    );

  const fastestTrip =
    validTrips.reduce(
      (best, trip) =>
        trip.travel_time_seconds <
          best.travel_time_seconds
          ? trip
          : best
    );

  return {
    trips: times.length,

    minSeconds:
      Math.min(...times),

    avgSeconds:
      Math.round(
        times.reduce(
          (sum, value) =>
            sum + value,
          0
        ) / times.length
      ),

    maxSeconds:
      Math.max(...times),

    fastest: {
      travelTimeSeconds:
        fastestTrip.travel_time_seconds,

      vehicleId:
        fastestTrip.vehicle_id,

      licensePlate:
        fastestTrip.license_plate,

      departureAt:
        fastestTrip.departure_at,

      passedAt:
        fastestTrip.passed_at
    }
  };
}

function formatDuration(
  seconds
) {
  if (
    seconds == null ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }

  const minutes =
    Math.floor(seconds / 60);

  const remainingSeconds =
    seconds % 60;

  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }

  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

function formatDayType(
  dayType
) {
  if (dayType === 'weekday') {
    return 'dia útil';
  }

  if (dayType === 'weekend') {
    return 'fim de semana';
  }

  return 'qualquer dia';
}

function isValidTime(
  value
) {
  const match =
    /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
      value
    );

  if (!match) {
    return false;
  }

  const hours =
    Number(match[1]);

  const minutes =
    Number(match[2]);

  const seconds =
    match[3] == null
      ? 0
      : Number(match[3]);

  return (
    hours >= 0 &&
    hours <= 23 &&
    minutes >= 0 &&
    minutes <= 59 &&
    seconds >= 0 &&
    seconds <= 59
  );
}

function formatTravelTimeStat({
  target,
  routeShortName,
  startTime,
  endTime,
  dayType,
  stats
}) {
  if (!stats.trips || !stats.fastest) {
    return (
      `${routeShortName} — ` +
      `${target.name} → ${target.destination}: ` +
      `sem viagens registadas entre ` +
      `${startTime.slice(0, 5)} e ${endTime.slice(0, 5)} ` +
      `(${formatDayType(dayType)}).`
    );
  }

  const fastest =
    stats.fastest;

  return (
    `A viagem mais rápida do ` +
    `${routeShortName} até ${target.name} ` +
    `foi de ${formatDuration(
      fastest.travelTimeSeconds
    )}, ` +
    `num ${formatDayType(dayType)} ` +
    `com partida entre as ` +
    `${startTime.slice(0, 5)} e ${endTime.slice(0, 5)}. ` +
    `Veículo ${fastest.vehicleId}` +
    (
      fastest.licensePlate
        ? ` (${fastest.licensePlate})`
        : ''
    ) +
    `.`
  );
}

function getAllTravelTimeStats({
  startTime,
  endTime,
  dayType
}) {
  return TARGETS.map(target => ({
    targetId:
      target.id,

    targetName:
      target.name,

    routeId:
      target.routeId,

    routeShortName:
      ROUTES.find(
        route =>
          route.routeId ===
          target.routeId
      )?.shortName ?? null,

    destination:
      target.destination,

    stats:
      getTravelTimeStats({
        targetId:
          target.id,

        startTime,

        endTime,

        dayType
      })
  }));
}



function savePassageEvent(vehicle) {
  const observedAt =
    new Date(
      vehicle.timestamp * 1000
    );

  const serviceDate =
    observedAt
      .toLocaleDateString(
        'en-CA',
        {
          timeZone: 'Europe/Lisbon'
        }
      );

  insertPassageEvent.run({
    serviceDate,

    observedAt:
      observedAt.toISOString(),

    routeId:
      vehicle.routeId,

    tripId:
      vehicle.tripId,

    vehicleId:
      vehicle.vehicleId,

    licensePlate:
      vehicle.licensePlate,

    targetId:
      vehicle.targetId,

    stopId:
      vehicle.stopId,

    scheduledArrival:
      vehicle.scheduledTargetArrivalTime
  });
}

const GTFS_URL =
  'https://gateway.carris.pt/gateway/gtfs/api/v2.11/GTFS';

const RT_URL =
  'https://gateway.carris.pt/gateway/gtfs/api/v2.11/GTFS/realtime/vehiclepositions';

const ROUTES = [
  {
    routeId: '195_0',
    shortName: '749'
  },
  {
    routeId: '110_0',
    shortName: '765'
  },
  {
    routeId: '112_0',
    shortName: '767'
  }
];

const TARGETS = [
  {
    id: '749-qta-freiras',
    routeId: '195_0',
    name: 'Qta. das Freiras',
    stopId: '3314',
    destination: 'Benfica'
  },
  {
    id: '749-charquinho',
    routeId: '195_0',
    name: 'Charquinho',
    stopId: '13705',
    destination: 'ISEL'
  },
  {
    id: '765-charquinho',
    routeId: '110_0',
    directionId: '1',
    name: 'Charquinho',
    stopId: '13705',
    destination: 'Colégio Militar (Metro)'
  },
  {
    id: '767-charquinho-test',
    routeId: '112_0',
    directionId: '1',
    name: 'Charquinho',
    stopId: '13705',
    destination: 'Campo Mártires Pátria'
  }
];

const POLL_INTERVAL_MS = 30000;

const ARRIVAL_TOLERANCE_M = 10;

const DISAPPEAR_AFTER_MS = 45000;

const SPEED_HISTORY_SIZE = 5;

const LAST_PASSED_MAX_AGE_MS = 60 * 60 * 1000;

// ==========================
// GEOMETRIA
// ==========================

function projectOnSegment(gps, a, b) {
  const lat0 = gps.lat * Math.PI / 180;

  const ax =
    a.lon * 111000 * Math.cos(lat0);

  const ay =
    a.lat * 111000;

  const bx =
    b.lon * 111000 * Math.cos(lat0);

  const by =
    b.lat * 111000;

  const px =
    gps.lon * 111000 * Math.cos(lat0);

  const py =
    gps.lat * 111000;

  const dx = bx - ax;
  const dy = by - ay;

  const lengthSquared =
    dx * dx + dy * dy;

  let t = 0;

  if (lengthSquared > 0) {
    t =
      ((px - ax) * dx +
        (py - ay) * dy) /
      lengthSquared;
  }

  t = Math.max(0, Math.min(1, t));

  const closestX = ax + t * dx;
  const closestY = ay + t * dy;

  const distance =
    Math.sqrt(
      (px - closestX) ** 2 +
      (py - closestY) ** 2
    );

  const shapeDist =
    a.shapeDist +
    t * (b.shapeDist - a.shapeDist);

  return {
    distance,
    shapeDist
  };
}

function matchGpsToShape(gps, shape) {
  let best = null;

  for (let i = 0; i < shape.length - 1; i++) {
    const candidate =
      projectOnSegment(
        gps,
        shape[i],
        shape[i + 1]
      );

    if (
      !best ||
      candidate.distance < best.distance
    ) {
      best = candidate;
    }
  }

  return best;
}

// ==========================
// CSV / GTFS
// ==========================

function parseCsvLine(line) {
  const fields = [];

  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (
        inQuotes &&
        line[i + 1] === '"'
      ) {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }

      continue;
    }

    if (
      char === ',' &&
      !inQuotes
    ) {
      fields.push(field);
      field = '';
      continue;
    }

    field += char;
  }

  fields.push(field);

  return fields;
}

function processCsv(zip, filename, onHeader, onRow) {
  let text =
    zip.readAsText(filename);

  let header = null;
  let start = 0;

  for (
    let i = 0;
    i <= text.length;
    i++
  ) {
    const endOfLine =
      i === text.length ||
      text.charCodeAt(i) === 10;

    if (!endOfLine) {
      continue;
    }

    let line =
      text.slice(start, i);

    if (line.endsWith('\r')) {
      line =
        line.slice(0, -1);
    }

    start = i + 1;

    if (!line) {
      continue;
    }

    if (!header) {
      header =
        parseCsvLine(line);

      if (onHeader) {
        onHeader(header);
      }

      continue;
    }

    onRow(
      parseCsvLine(line)
    );
  }

  // Permitir que o texto gigante
  // fique elegível para GC assim que
  // terminarmos de processar o ficheiro.
  text = null;
}

async function loadGTFS() {
  const response =
    await fetch(GTFS_URL);

  if (!response.ok) {
    throw new Error(
      `GTFS HTTP ${response.status}`
    );
  }

  const buffer =
    await response.arrayBuffer();

  return new Adm(
    Buffer.from(buffer)
  );
}

async function loadRealtime() {
  const response =
    await fetch(RT_URL);

  if (!response.ok) {
    throw new Error(
      `Realtime HTTP ${response.status}`
    );
  }

  const buffer =
    await response.arrayBuffer();

  return FeedMessage.decode(
    new Uint8Array(buffer)
  );
}

// ==========================
// PREPARAR GTFS
// ==========================

async function prepareData() {
  console.log('A descarregar GTFS...');

  const zip =
    await loadGTFS();

  console.log('GTFS descarregado.');

  // ==========================
  // ROUTES
  // ==========================

  const routesById =
    new Map();

  let routeIdIndex = -1;
  let routeShortNameIndex = -1;
  let routeLongNameIndex = -1;

  processCsv(
    zip,
    'routes.txt',

    header => {
      routeIdIndex =
        header.indexOf('route_id');

      routeShortNameIndex =
        header.indexOf(
          'route_short_name'
        );

      routeLongNameIndex =
        header.indexOf(
          'route_long_name'
        );
    },

    row => {
      const routeId =
        row[routeIdIndex];

      const routeConfig =
        ROUTES.find(
          route =>
            route.routeId === routeId &&
            route.shortName ===
            row[routeShortNameIndex]
        );

      if (!routeConfig) {
        return;
      }

      routesById.set(
        routeId,
        {
          routeId,
          shortName:
            row[routeShortNameIndex],
          longName:
            row[routeLongNameIndex]
        }
      );
    }
  );

  for (const route of routesById.values()) {
    console.log(
      `Rota: ${route.shortName} — ${route.longName}`
    );
  }

  if (
    routesById.size !==
    ROUTES.length
  ) {
    throw new Error(
      'Nem todas as rotas configuradas foram encontradas no GTFS.'
    );
  }

  // ==========================
  // TRIPS
  // ==========================

  const routeTrips =
    new Map();

  let tripRouteIndex = -1;
  let tripIdIndex = -1;
  let shapeIdIndex = -1;
  let tripServiceIndex = -1;
  let directionIdIndex = -1;

  processCsv(
    zip,
    'trips.txt',

    header => {
      tripRouteIndex =
        header.indexOf('route_id');

      tripIdIndex =
        header.indexOf('trip_id');

      shapeIdIndex =
        header.indexOf('shape_id');

      directionIdIndex =
        header.indexOf('direction_id');

      tripServiceIndex =
        header.indexOf('service_id');
    },

    row => {
      if (
        !routesById.has(
          row[tripRouteIndex]
        )
      ) {
        return;
      }

      const tripId =
        row[tripIdIndex];

      routeTrips.set(
        tripId,
        {
          tripId,

          routeId:
            row[tripRouteIndex],

          shapeId:
            row[shapeIdIndex],

          directionId:
            row[directionIdIndex],

          serviceId:
            row[tripServiceIndex]
        }
      );
    }
  );

  const calendar =
    new Map();

  const calendarDates =
    new Map();

  processCsv(
    zip,
    'calendar.txt',

    header => {
      // Não precisamos de processar
      // o header diretamente.
    },

    row => {
      calendar.set(
        row[0],
        {
          monday:
            row[1] === '1',

          tuesday:
            row[2] === '1',

          wednesday:
            row[3] === '1',

          thursday:
            row[4] === '1',

          friday:
            row[5] === '1',

          saturday:
            row[6] === '1',

          sunday:
            row[7] === '1',

          startDate:
            row[8],

          endDate:
            row[9]
        }
      );
    }
  );

  processCsv(
    zip,
    'calendar_dates.txt',

    header => {
      // Não precisamos de processar
      // o header diretamente.
    },

    row => {
      if (
        !calendarDates.has(
          row[0]
        )
      ) {
        calendarDates.set(
          row[0],
          []
        );
      }

      calendarDates
        .get(row[0])
        .push({
          date:
            row[1],

          exceptionType:
            Number(row[2])
        });
    }
  );

  console.log(
    `Trips das rotas configuradas: ${routeTrips.size}`
  );

  // ==========================
  // STOP TIMES
  // ==========================

  const stopTimesByTrip =
    new Map();

  let stTripIdIndex = -1;
  let stStopIdIndex = -1;
  let stSequenceIndex = -1;
  let stShapeDistIndex = -1;
  let stArrivalTimeIndex = -1;
  let stDepartureTimeIndex = -1;

  processCsv(
    zip,
    'stop_times.txt',

    header => {
      stTripIdIndex =
        header.indexOf('trip_id');

      stStopIdIndex =
        header.indexOf('stop_id');

      stSequenceIndex =
        header.indexOf(
          'stop_sequence'
        );

      stShapeDistIndex =
        header.indexOf(
          'shape_dist_traveled'
        );

      stArrivalTimeIndex =
        header.indexOf(
          'arrival_time'
        );

      stDepartureTimeIndex =
        header.indexOf(
          'departure_time'
        );
    },

    row => {
      const tripId =
        row[stTripIdIndex];

      // Ignorar imediatamente todos
      // os trips que não pertencem às rotas configuradas.
      if (
        !routeTrips.has(tripId)
      ) {
        return;
      }

      if (
        !stopTimesByTrip.has(tripId)
      ) {
        stopTimesByTrip.set(
          tripId,
          []
        );
      }

      stopTimesByTrip
        .get(tripId)
        .push({
          stopId:
            row[stStopIdIndex],

          sequence:
            Number(
              row[stSequenceIndex]
            ),

          shapeDist:
            Number(
              row[stShapeDistIndex]
            ),

          arrivalTime:
            row[stArrivalTimeIndex],

          departureTime:
            row[stDepartureTimeIndex]
        });
    }
  );

  for (
    const stops of
    stopTimesByTrip.values()
  ) {
    stops.sort(
      (a, b) =>
        a.sequence - b.sequence
    );
  }

  console.log(
    `Trips com stop_times: ${stopTimesByTrip.size}`
  );

  // ==========================
  // STOPS
  // ==========================

  // Recolher apenas as paragens que
  // pertencem aos trips da 749.
  const requiredStopIds =
    new Set();

  for (
    const stops of
    stopTimesByTrip.values()
  ) {
    for (const stop of stops) {
      requiredStopIds.add(
        stop.stopId
      );
    }
  }

  const stopNames =
    new Map();

  let stopIdIndex = -1;
  let stopNameIndex = -1;

  processCsv(
    zip,
    'stops.txt',

    header => {
      stopIdIndex =
        header.indexOf(
          'stop_id'
        );

      stopNameIndex =
        header.indexOf(
          'stop_name'
        );
    },

    row => {
      const stopId =
        row[stopIdIndex];

      // Ignorar todas as paragens
      // que não pertencem às rotas configuradas.
      if (
        !requiredStopIds.has(
          stopId
        )
      ) {
        return;
      }

      stopNames.set(
        stopId,
        row[stopNameIndex]
      );
    }
  );

  console.log(
    `Stops relevantes: ${stopNames.size}`
  );

  // ==========================
  // SHAPES
  // ==========================

  const requiredShapeIds =
    new Set();

  for (
    const trip of
    routeTrips.values()
  ) {
    if (trip.shapeId) {
      requiredShapeIds.add(
        trip.shapeId
      );
    }
  }

  console.log(
    `Shapes necessárias: ${requiredShapeIds.size}`
  );

  const shapesById =
    new Map();

  let shapeIdColumn = -1;
  let shapeLatIndex = -1;
  let shapeLonIndex = -1;
  let shapeSeqIndex = -1;
  let shapeDistIndex = -1;

  processCsv(
    zip,
    'shapes.txt',

    header => {
      shapeIdColumn =
        header.indexOf(
          'shape_id'
        );

      shapeLatIndex =
        header.indexOf(
          'shape_pt_lat'
        );

      shapeLonIndex =
        header.indexOf(
          'shape_pt_lon'
        );

      shapeSeqIndex =
        header.indexOf(
          'shape_pt_sequence'
        );

      shapeDistIndex =
        header.indexOf(
          'shape_dist_traveled'
        );
    },

    row => {
      const shapeId =
        row[shapeIdColumn];

      // Ignorar imediatamente shapes
      // que não pertencem às rotas configuradas.
      if (
        !requiredShapeIds.has(
          shapeId
        )
      ) {
        return;
      }

      if (
        !shapesById.has(shapeId)
      ) {
        shapesById.set(
          shapeId,
          []
        );
      }

      shapesById
        .get(shapeId)
        .push({
          seq:
            Number(
              row[shapeSeqIndex]
            ),

          lat:
            Number(
              row[shapeLatIndex]
            ),

          lon:
            Number(
              row[shapeLonIndex]
            ),

          shapeDist:
            Number(
              row[shapeDistIndex]
            )
        });
    }
  );

  for (
    const shape of
    shapesById.values()
  ) {
    shape.sort(
      (a, b) =>
        a.seq - b.seq
    );
  }

  // ==========================
  // TARGETS POR TRIP
  // ==========================

  const targetsByTrip =
    new Map();

  for (const target of TARGETS) {
    for (const [
      tripId,
      stops
    ] of stopTimesByTrip) {
      const trip =
        routeTrips.get(tripId);

      if (!trip) {
        continue;
      }

      if (
        target.routeId !==
        trip.routeId
      ) {
        continue;
      }

      if (
        target.directionId != null &&
        target.directionId !==
        trip.directionId
      ) {
        continue;
      }

      const targetStop =
        stops.find(
          stop =>
            stop.stopId ===
            target.stopId
        );

      if (!targetStop) {
        continue;
      }

      const firstStop =
        stops.reduce(
          (first, stop) =>
            stop.sequence <
              first.sequence
              ? stop
              : first
        );

      if (!targetsByTrip.has(tripId)) {
        targetsByTrip.set(
          tripId,
          []
        );
      }

      targetsByTrip
        .get(tripId)
        .push({
          tripId:
            tripId,

          serviceId:
            trip.serviceId,
          targetId: target.id,
          targetName: target.name,
          destination: target.destination,
          stopId: target.stopId,
          stopSequence:
            targetStop.sequence,

          firstStopSequence:
            firstStop.sequence,

          firstStopName:
            stopNames.get(
              firstStop.stopId
            ) ?? firstStop.stopId,

          targetShapeDist:
            targetStop.shapeDist,

          scheduledDepartureTime:
            firstStop.departureTime,

          scheduledTargetArrivalTime:
            targetStop.arrivalTime
        });
    }
  }

  console.log(
    '\nTargets configurados:'
  );

  for (const target of TARGETS) {
    let count = 0;

    for (
      const targets of
      targetsByTrip.values()
    ) {
      if (
        targets.some(
          t =>
            t.targetId ===
            target.id
        )
      ) {
        count++;
      }
    }

    console.log(
      `  ${target.name} → ${target.destination}: ${count} trips`
    );
  }

  console.log(
    `Shapes carregadas: ${shapesById.size}`
  );

  return {
    routeTrips,
    stopTimesByTrip,
    targetsByTrip,
    shapesById,
    stopNames,
    calendar,
    calendarDates
  };
}

function getTripDirection(stops) {
  if (!stops || stops.length < 2) return null;

  const first = stops[0];
  const last = stops[stops.length - 1];

  if (
    !Number.isFinite(first.shapeDist) ||
    !Number.isFinite(last.shapeDist)
  ) {
    return null;
  }

  if (last.shapeDist > first.shapeDist) {
    return 1;
  }

  if (last.shapeDist < first.shapeDist) {
    return -1;
  }

  return null;
}

// ==========================
// REALTIME
// ==========================

async function getVehicles(data) {
  const feed =
    await loadRealtime();

  console.log(
    `Realtime entities: ${feed.entity.length}`
  );

  const vehicles = [];

  for (
    const entity of feed.entity
  ) {
    const vehicle =
      entity.vehicle;

    if (
      !vehicle?.vehicle?.id
    ) {
      continue;
    }

    const tripId =
      vehicle.trip?.tripId;

    if (!tripId) {
      continue;
    }

    const trip =
      data.routeTrips.get(tripId);

    if (!trip) {
      continue;
    }

    console.log(
      `Trip encontrado: ${tripId} | veículo: ${vehicle.vehicle.id}`
    );
    const targets =
      data.targetsByTrip.get(
        tripId
      );

    if (
      !targets ||
      targets.length === 0
    ) {
      continue;
    }

    const lat =
      vehicle.position?.latitude;

    const lon =
      vehicle.position?.longitude;

    if (
      lat === undefined ||
      lon === undefined
    ) {
      continue;
    }

    const shape =
      data.shapesById.get(
        trip.shapeId
      );

    if (
      !shape ||
      shape.length < 2
    ) {
      continue;
    }

    const matched =
      matchGpsToShape(
        { lat, lon },
        shape
      );

    const timestamp =
      Number(
        vehicle.timestamp
      );

    if (
      !Number.isFinite(timestamp)
    ) {
      continue;
    }

    const stops =
      data.stopTimesByTrip.get(
        tripId
      );
    const direction =
      getTripDirection(
        stops
      );

    const currentStopSequence =
      Number(
        vehicle.currentStopSequence
      );

    const currentStop =
      stops?.find(
        stop =>
          stop.sequence ===
          currentStopSequence
      );

    const currentStopName =
      currentStop
        ? data.stopNames.get(
          currentStop.stopId
        )
        : null;

    console.log(
      `DEBUG ${vehicle.vehicle.id} | ` +
      `matricula=${vehicle.vehicle.licensePlate || '—'} | ` +
      `trip=${tripId} | ` +
      `direction=${direction} | ` +
      `seq=${currentStopSequence} | ` +
      `stop=${currentStopName ?? '—'} | ` +
      `shapeDist=${matched.shapeDist.toFixed(1)}`
    );
    for (const target of targets) {
      let remaining;

      if (direction === 1) {
        remaining =
          target.targetShapeDist -
          matched.shapeDist;
      } else if (direction === -1) {
        remaining =
          matched.shapeDist -
          target.targetShapeDist;
      } else {
        continue;
      }

      console.log(
        `DEBUG TARGET ${vehicle.vehicle.id} | ${target.targetName} | targetDist=${target.targetShapeDist} | vehicleDist=${matched.shapeDist.toFixed(1)} | remaining=${remaining.toFixed(1)}`
      );
      /*
       * Se o veículo já passou o target,
       * devolvemos a leitura para que o tracker
       * possa detetar a passagem.
       */
      const passedTarget =
        remaining < -ARRIVAL_TOLERANCE_M;

      vehicles.push({
        passedTarget,

        targetId:
          target.targetId,

        stopId:
          target.stopId,
        scheduledDepartureTime:
          target.scheduledDepartureTime,

        scheduledTargetArrivalTime:
          target.scheduledTargetArrivalTime,

        targetName:
          target.targetName,

        firstStopName:
          target.firstStopName,

        destination:
          target.destination,

        vehicleId:
          vehicle.vehicle.id,

        licensePlate:
          vehicle.vehicle.licensePlate ||
          null,

        routeId:
          trip.routeId,

        tripId,

        direction,

        directionId:
          trip.directionId,

        currentStopSequence:
          vehicle.currentStopSequence,

        currentStopId:
          currentStop?.stopId ?? null,

        currentStopName:
          currentStopName ?? null,

        targetStopSequence:
          target.stopSequence,

        firstStopSequence:
          target.firstStopSequence,

        lat,
        lon,

        timestamp,

        shapeDist:
          matched.shapeDist,

        targetShapeDist:
          target.targetShapeDist,

        remaining:
          Math.max(
            0,
            remaining
          ),

        gpsDistance:
          matched.distance
      });
    }
  }

  return vehicles;
}

// ==========================
// FORMATA��O
// ==========================

function formatTime(timestamp) {
  return new Date(
    timestamp * 1000
  ).toLocaleTimeString(
    'pt-PT'
  );
}

function formatMinutes(seconds) {
  if (
    !Number.isFinite(seconds)
  ) {
    return '�';
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes =
    Math.floor(
      seconds / 60
    );

  const secs =
    Math.round(
      seconds % 60
    );

  return `${minutes}m ${secs}s`;
}

function formatAge(seconds) {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

// ==========================
// HIST�RICO / VELOCIDADE
// ==========================

function calculateSpeed(history) {
  if (!history || history.length < 2) {
    return {
      instant: null,
      average: null
    };
  }

  const segments = [];

  for (
    let i = 1;
    i < history.length;
    i++
  ) {
    const previous =
      history[i - 1];

    const current =
      history[i];

    const dt =
      current.timestamp -
      previous.timestamp;

    const dd =
      Math.abs(
        current.shapeDist -
        previous.shapeDist
      );

    if (
      dt <= 0 ||
      dd < 20
    ) {
      continue;
    }

    const speed =
      (dd / dt) * 3.6;

    if (
      speed >= 2 &&
      speed <= 60
    ) {
      segments.push({
        speed,
        dt
      });
    }
  }

  if (segments.length === 0) {
    return {
      instant: null,
      average: null
    };
  }

  const instant =
    segments[
      segments.length - 1
    ].speed;

  /*
   * Não calcular velocidade média/ETA
   * com menos de 3 segmentos válidos.
   */
  if (segments.length < 3) {
    return {
      instant,
      average: null
    };
  }

  /*
   * Para a ETA usamos a mediana
   * das velocidades recentes.
   *
   * Isto reduz o impacto de:
   * - GPS instável
   * - saltos no map matching
   * - velocidades instantâneas anormais
   */
  const recent =
    segments.slice(
      -SPEED_HISTORY_SIZE
    );

  const sortedSpeeds =
    recent
      .map(segment => segment.speed)
      .sort((a, b) => a - b);

  const middle =
    Math.floor(
      sortedSpeeds.length / 2
    );

  let average;

  if (
    sortedSpeeds.length % 2 === 0
  ) {
    average =
      (
        sortedSpeeds[middle - 1] +
        sortedSpeeds[middle]
      ) / 2;
  } else {
    average =
      sortedSpeeds[middle];
  }

  return {
    instant,
    average
  };
}

function calculateEta(
  remaining,
  speedKmh
) {
  if (
    !Number.isFinite(
      speedKmh
    ) ||
    speedKmh < 2 ||
    speedKmh > 60 ||
    remaining <= 0
  ) {
    return null;
  }

  return (
    (remaining / 1000) /
    speedKmh *
    3600
  );
}

// ==========================
// WEB / API
// ==========================

function buildStatus(
  tracker,
  currentKeys,
  lastPassedByTarget,
  targetsByTrip,
  calendar,
  calendarDates,
  referenceDate = new Date()
) {
  return {
    updatedAt: new Date().toISOString(),

    targets: TARGETS.map(target => {
      const vehicles = [...tracker.entries()]
        .filter(([key, state]) =>
          currentKeys.has(key) &&
          state.lastResult &&
          state.lastResult.targetId === target.id
        )
        .map(([, state]) => state.lastResult)
        .sort(
          (a, b) =>
            a.remaining - b.remaining
        );

      const next =
        vehicles[0] ?? null;

      const targetSchedule =
        [...targetsByTrip.values()]
          .flat()
          .find(
            item =>
              item.targetId ===
              target.id
          );

      const firstStopName =
        targetSchedule?.firstStopName ??
        null;

      const lastPassed =
        lastPassedByTarget.get(target.id) ?? null;

      const nextScheduledTargetArrival =
        getNextScheduledTargetArrival(
          target.id,
          targetsByTrip,
          calendar,
          calendarDates,
          referenceDate,
          lastPassed
        );

      const lastPassedAgeMs =
        lastPassed
          ? Date.now() - lastPassed.passedAt
          : null;

      const recentLastPassed =
        lastPassed &&
          lastPassedAgeMs >= 0 &&
          lastPassedAgeMs <=
          LAST_PASSED_MAX_AGE_MS
          ? {
            vehicleId:
              lastPassed.vehicleId,
            licensePlate:
              lastPassed.licensePlate,
            passedAt:
              new Date(
                lastPassed.passedAt
              ).toISOString()
          }
          : null;

      return {
        id: target.id,
        routeShortName:
          ROUTES.find(
            route =>
              route.routeId ===
              target.routeId
          )?.shortName ?? target.routeId,
        name: target.name,
        firstStopName:
          firstStopName,
        destination: target.destination,

        next: next
          ? {
            vehicleId: next.vehicleId,
            licensePlate:
              next.licensePlate,
            currentStopName:
              next.currentStopName,
            etaSeconds: next.eta,
            remainingMeters: next.remaining,
            averageSpeedKmh: next.averageSpeed,
            timestamp: next.timestamp,

            scheduledDepartureTime:
              next.scheduledDepartureTime,

            scheduledTargetArrivalTime:
              next.scheduledTargetArrivalTime
          }
          : null,

        lastPassed:
          recentLastPassed,

        nextScheduledTargetArrival:
          nextScheduledTargetArrival,


        vehicles: vehicles.map(vehicle => ({
          vehicleId: vehicle.vehicleId,
          licensePlate:
            vehicle.licensePlate,
          currentStopName:
            vehicle.currentStopName,
          etaSeconds: vehicle.eta,
          remainingMeters: vehicle.remaining,
          averageSpeedKmh: vehicle.averageSpeed,
          timestamp: vehicle.timestamp,
          scheduledDepartureTime:
            vehicle.scheduledDepartureTime,
          scheduledTargetArrivalTime:
            vehicle.scheduledTargetArrivalTime
        }))
      };
    })
  };
}

function startWebServer(getStatus) {
  const port =
    Number(process.env.PORT) || 3000;

  const server =
    http.createServer((req, res) => {

      if (req.url.startsWith('/api/stats')) {
        const url =
          new URL(
            req.url,
            `http://${req.headers.host || 'localhost'}`
          );

        const startTime =
          url.searchParams.get(
            'start'
          ) || '00:00:00';

        const endTime =
          url.searchParams.get(
            'end'
          ) || '24:00:00';

        const dayType =
          url.searchParams.get(
            'day'
          ) || 'all';

        const validDayTypes = [
          'weekday',
          'weekend',
          'all'
        ];

        if (
          !isValidTime(startTime) ||
          !isValidTime(endTime)
        ) {
          res.writeHead(400, {
            'Content-Type':
              'application/json; charset=utf-8',
            'Cache-Control':
              'no-store'
          });

          res.end(
            JSON.stringify({
              error:
                'start e end devem estar no formato HH:MM ou HH:MM:SS'
            })
          );

          return;
        }

        if (
          !validDayTypes.includes(
            dayType
          )
        ) {
          res.writeHead(400, {
            'Content-Type':
              'application/json; charset=utf-8',
            'Cache-Control':
              'no-store'
          });

          res.end(
            JSON.stringify({
              error:
                'day deve ser weekday, weekend ou all'
            })
          );

          return;
        }

        const stats =
          getAllTravelTimeStats({
            startTime,
            endTime,
            dayType
          });

        res.writeHead(200, {
          'Content-Type':
            'application/json; charset=utf-8',
          'Cache-Control':
            'no-store'
        });

        res.end(
          JSON.stringify({
            filters: {
              startTime,
              endTime,
              dayType
            },
            results: stats
          })
        );

        return;
      }

      if (req.url === '/api/status') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });

        res.end(
          JSON.stringify(getStatus())
        );

        return;
      }

      if (
        req.url === '/' ||
        req.url === '/index.html'
      ) {
        const html = [
          '<!doctype html>',
          '<html lang="pt-PT">',
          '<head>',
          '<meta charset="utf-8">',
          '<meta name="viewport" content="width=device-width,initial-scale=1">',
          '<title>Monitor de autocarros</title>',
          '<style>',
          '*{box-sizing:border-box}',
          'body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px 16px 40px;background:#f1f3f5;color:#17202a}',
          'main{max-width:560px;margin:0 auto}',
          'h1{font-size:28px;line-height:1.2;margin:0 0 24px;letter-spacing:-.5px}',
          '.card{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:18px;margin-bottom:16px;box-shadow:0 3px 12px rgba(0,0,0,.06)}',
          '.accordion-header{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;user-select:none}',
          '.accordion-header .route{margin-bottom:0}',
          '.target-stop{font-weight:700}',
          '.accordion-icon{font-size:20px;color:#6b7280;transition:transform .15s ease}',
          '.accordion-icon.open{transform:rotate(90deg)}',
          '.accordion-content{margin-top:16px}',
          '.accordion-status{margin-top:4px;font-size:13px;color:#6b7280}',
          '.accordion-status.arriving{color:#15803d;font-weight:700}',
          '.accordion-status{margin-top:4px;font-size:13px;color:#6b7280;display:flex;align-items:center;gap:7px}',
          '.accordion-status.arriving{color:#15803d;font-weight:700}',
          '.status-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;flex:0 0 auto;animation:pulse-dot 1.4s ease-in-out infinite}',
          '@keyframes pulse-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}',
          '.route{font-size:14px;font-weight:500;color:#4b5563;margin-bottom:14px}',
          '.route strong{color:#111827;font-weight:750}',
          '.vehicle{border:1px solid #e5e7eb;border-radius:14px;padding:16px;background:#fafafa}',
          '.vehicle.next{background:#fff;border-color:#d7dce2}',
          '.vehicle-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}',
          '.vehicle-id{font-size:24px;font-weight:800;letter-spacing:-.5px}',
          '.badge{font-size:11px;font-weight:800;letter-spacing:.5px;padding:5px 8px;border-radius:999px;background:#e8f1ff;color:#2457a6;white-space:nowrap}',
          '.vehicle-stop{font-size:17px;font-weight:650;margin-bottom:2px}',
          '.vehicle-stop-label{font-size:12px;color:#6b7280;margin-bottom:16px}',
          '.vehicle-main{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}',
          '.metric{background:#f3f4f6;border-radius:12px;padding:12px}',
          '.metric-label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;margin-bottom:3px}',
          '.metric-value{font-size:25px;font-weight:750;line-height:1.2}',
          '.vehicle-details{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:13px;color:#4b5563}',
          '.detail strong{color:#17202a;font-weight:650}',
          '.updated{font-size:12px;color:#8a919a;margin-top:12px;text-align:right}',
          '.none{padding:18px 4px 10px;text-align:center;color:#6b7280;font-size:14px;line-height:1.6}',
          '.last-passed{margin-top:10px;font-size:13px;color:#6b7280}',
          '.schedule{margin-top:10px;font-size:13px;color:#6b7280;line-height:1.6}',
          '.none strong{display:block;color:#374151;font-size:15px;margin-bottom:2px}',
          '.others-title{font-size:11px;font-weight:800;letter-spacing:.7px;color:#8a919a;margin:16px 2px 8px}',
          '.other-vehicle{margin-top:8px}',
          '.error{color:#b42318}',
          '.stats-card{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:18px;margin-top:24px;box-shadow:0 3px 12px rgba(0,0,0,.06)}',
          '.stats-title{font-size:18px;font-weight:750;margin-bottom:16px}',
          '.stats-filters{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px}',
          '.stats-filter label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;margin-bottom:5px}',
          '.stats-filter select,.stats-filter input{width:100%;padding:9px 10px;border:1px solid #d1d5db;border-radius:10px;background:#fff;font:inherit;font-size:14px}',
          '.stats-result{padding:12px 0;border-top:1px solid #e5e7eb;font-size:14px;line-height:1.5}',
          '.stats-result:first-child{border-top:0}',
          '.stats-route{font-weight:700;margin-bottom:3px}',
          '.stats-values{color:#4b5563;font-size:13px}',
          '.stats-fastest{margin-top:6px}',
          '.stats-loading{color:#6b7280;font-size:14px}',
          '@media (max-width:420px){.metric-value{font-size:22px}.vehicle-details{grid-template-columns:1fr}}',
          '</style>',
          '</head>',
          '<body>',
          '<main>',
          '<h1>Monitor de autocarros</h1>',
          '<div id="app">A carregar...</div>',
          '<section class="stats-card">',
          '<div class="stats-title">Estatísticas</div>',
          '<div class="stats-filters">',
          '<div class="stats-filter">',
          '<label for="stats-start">Das</label>',
          '<input id="stats-start" type="time" value="09:00">',
          '</div>',
          '<div class="stats-filter">',
          '<label for="stats-end">Às</label>',
          '<input id="stats-end" type="time" value="10:00">',
          '</div>',
          '<div class="stats-filter">',
          '<label for="stats-day">Dia</label>',
          '<select id="stats-day">',
          '<option value="weekday">Dia útil</option>',
          '<option value="weekend">Fim de semana</option>',
          '<option value="all">Todos</option>',
          '</select>',
          '</div>',
          '<div class="stats-filter">',
          '<label for="stats-target">Carreira</label>',
          '<select id="stats-target">',
          '<option value="all">Todas</option>',
          '<option value="749-qta-freiras">749 · Qta. das Freiras → Benfica</option>',
          '<option value="749-charquinho">749 · Charquinho → ISEL</option>',
          '<option value="765-charquinho">765 · Charquinho → Colégio Militar (Metro)</option>',
          '</select>',
          '</div>',
          '</div>',
          '<div id="stats-results" class="stats-loading">A carregar estatísticas...</div>',
          '</section>',
          '</main>',
          '<script>',
          'const openTargets=new Set();',
          'function fmtEta(s){',
          'if(s==null)return "A calcular";',
          'const totalSeconds=Math.max(0,Math.round(s));',
          'const minutes=Math.floor(totalSeconds/60);',
          'const seconds=totalSeconds%60;',
          'if(minutes===0)return seconds+" s";',
          'if(seconds===0)return minutes+"m";',
          'return minutes+"m "+seconds+"s";',
          '}',
          'function fmtTime(iso){',
          'if(!iso)return "hora desconhecida";',
          'const date=new Date(iso);',
          'return date.toLocaleTimeString("pt-PT",{',
          'hour:"2-digit",',
          'minute:"2-digit",',
          'second:"2-digit"',
          '});',
          '}',
          'function fmtRelativeTime(iso){',
          'if(!iso)return null;',
          'const seconds=Math.max(0,Math.floor((Date.now()-new Date(iso).getTime())/1000));',
          'if(seconds<60)return seconds+" s";',
          'const minutes=Math.floor(seconds/60);',
          'if(minutes<60)return minutes+" min";',
          'const hours=Math.floor(minutes/60);',
          'return hours+" h";',
          '}',
          'function fmtScheduledTime(time) {',
          'if(!time)return null;',
          'const parts=time.split(":");',
          'if(parts.length<2)return time;',
          'return parts[0]+":"+parts[1];',
          '}',
          'function accordionStatus(t){',
          'if(t.next && Number.isFinite(t.next.remainingMeters)){',
          'if(t.next.remainingMeters<=599){',
          'return "<div class=\\"accordion-status arriving\\"><span class=\\"status-dot\\"></span>A chegar!</div>";',
          '}',
          'return "<div class=\\"accordion-status\\"><span class=\\"status-dot\\"></span>A caminho</div>";',
          '}',
          '',
          'if(t.nextScheduledTargetArrival){',
          'return "<div class=\\"accordion-status\\">Próxima passagem prevista na paragem às <strong>"+fmtScheduledTime(t.nextScheduledTargetArrival)+"</strong></div>";',
          '}',
          '',
          'return "";',
          '}',
          'function toggleTarget(targetId){',
          'if(openTargets.has(targetId)){',
          'openTargets.delete(targetId);',
          '}else{',
          'openTargets.add(targetId);',
          '}',
          'refresh();',
          '}',
          'function scheduleInfo(n,t){',
          'const departure=n.scheduledDepartureTime;',
          'const arrival=n.scheduledTargetArrivalTime;',
          'if(!arrival)return "";',
          'const now=new Date();',
          'const datePart=now.toISOString().slice(0,10);',
          'const arrivalDate=new Date(',
          'datePart+"T"+arrival',
          ');',
          'const departureDate=departure',
          '?new Date(',
          'datePart+"T"+departure',
          ')',
          ':null;',
          'let html="";',
          'if(departureDate && now>=departureDate){',
          'html+="<div>Partida prevista da paragem inicial às <strong>"+',
          'fmtScheduledTime(departure)+',
          '"</strong></div>";',
          '}else if(departure){',
          'html+="<div>Partida prevista da paragem inicial às <strong>"+',
          'fmtScheduledTime(departure)+',
          '"</strong></div>";',
          '}',
          'if(now>=arrivalDate){',
          'const delayMinutes=Math.floor(',
          '(now-arrivalDate)/60000',
          ');',
          'html+="<div>Devia ter passado na <strong>"+',
          't.name+',
          '"</strong> às <strong>"+',
          'fmtScheduledTime(arrival)+',
          '"</strong>. Atraso: <strong>"+',
          'delayMinutes+',
          '" min</strong></div>";',
          '}else{',
          'html+="<div>Deverá passar na <strong>"+',
          't.name+',
          '"</strong> às <strong>"+',
          'fmtScheduledTime(arrival)+',
          '"</strong></div>";',
          '}',
          'return "<div class=\\"schedule\\">"+',
          'html+',
          '"</div>";',
          '}',
          'function vehicleHtml(v,isNext,updatedAt){',
          'const speed=v.averageSpeedKmh==null?"a calcular":v.averageSpeedKmh.toFixed(1)+" km/h";',
          'return "<div class=\\"vehicle "+(isNext?"next":"")+"\\">"+',
          '"<div class=\\"vehicle-header\\">"+',
          '"<span class=\\"vehicle-id\\">"+v.vehicleId+"</span>"+',
          '(isNext?"<span class=\\"badge\\">PRÓXIMO</span>":"")+',
          '"</div>"+',
          '"<div class=\\"vehicle-stop\\">"+(v.currentStopName||"Localização desconhecida")+"</div>"+',
          '"<div class=\\"vehicle-stop-label\\">Paragem atual</div>"+',
          '"<div class=\\"vehicle-main\\">"+',
          '"<div class=\\"metric\\">"+',
          '"<div class=\\"metric-label\\">Distância</div>"+',
          '"<div class=\\"metric-value\\">"+Math.round(v.remainingMeters)+" m</div>"+',
          '"</div>"+',
          '"<div class=\\"metric\\">"+',
          '"<div class=\\"metric-label\\">ETA</div>"+',
          '"<div class=\\"metric-value\\">"+fmtEta(v.etaSeconds)+"</div>"+',
          '"</div>"+',
          '"</div>"+',
          '"<div class=\\"vehicle-details\\">"+',
          '"<div class=\\"detail\\">Matrícula: <strong>"+(v.licensePlate||"Desconhecida")+"</strong></div>"+',
          '"<div class=\\"detail\\">Velocidade: <strong>"+speed+"</strong></div>"+',
          '"</div>"+',
          '"<div class=\\"updated\\">Informação obtida às "+fmtTime(updatedAt)+"</div>"+',
          '"</div>";',
          '}',
          'function fmtDuration(seconds){',
          'if(seconds==null || !Number.isFinite(seconds))return "—";',
          'const minutes=Math.floor(seconds/60);',
          'const remainingSeconds=seconds%60;',
          'if(minutes===0)return remainingSeconds+"s";',
          'if(remainingSeconds===0)return minutes+"m";',
          'return minutes+"m "+remainingSeconds+"s";',
          '}',
          'async function refreshStats(){',
          'const start=document.getElementById("stats-start").value;',
          'const end=document.getElementById("stats-end").value;',
          'const day=document.getElementById("stats-day").value;',
          'const targetId=document.getElementById("stats-target").value;',
          'const results=document.getElementById("stats-results");',
          '',
          'if(!start || !end){',
          'results.innerHTML="<div class=\\"stats-loading\\">Indica o intervalo horário.</div>";',
          'return;',
          '}',
          '',
          'results.innerHTML="<div class=\\"stats-loading\\">A carregar estatísticas...</div>";',
          '',
          'try{',
          'const params=new URLSearchParams({',
          'start:start+":00",',
          'end:end+":00",',
          'day:day',
          '});',
          '',
          'const r=await fetch(',
          '"/api/stats?"+params.toString(),',
          '{cache:"no-store"}',
          ');',
          '',
          'if(!r.ok){',
          'const error=await r.json().catch(function(){',
          'return {error:"HTTP "+r.status};',
          '});',
          '',
          'throw new Error(',
          'error.error || "HTTP "+r.status',
          ');',
          '}',
          '',
          'const data=await r.json();',
          '',
          'const filteredResults=data.results.filter(function(result){',
          'return targetId==="all" || result.targetId===targetId;',
          '});',
          '',
          'results.innerHTML=filteredResults.map(function(result){',
          'const stats=result.stats;',
          '',
          'if(!stats.trips){',
          'return "<div class=\\"stats-result\\">"+',
          '"<div class=\\"stats-route\\">"+',
          'result.routeShortName+',
          '" · "+',
          'result.targetName+',
          '" → "+',
          'result.destination+',
          '"</div>"+',
          '"<div class=\\"stats-values\\">"+',
          '"Sem viagens registadas neste período."+',
          '"</div>"+',
          '"</div>";',
          '}',
          '',
          'const fastest=stats.fastest;',
          '',
          'return "<div class=\\"stats-result\\">"+',
          '"<div class=\\"stats-route\\">"+',
          'result.routeShortName+',
          '" · "+',
          'result.targetName+',
          '" → "+',
          'result.destination+',
          '"</div>"+',
          '"<div class=\\"stats-values\\">"+',
          'stats.trips+',
          '(stats.trips===1?" viagem":" viagens")+',
          '" · mais rápida "+',
          'fmtDuration(stats.minSeconds)+',
          '" · média "+',
          'fmtDuration(stats.avgSeconds)+',
          '" · mais lenta "+',
          'fmtDuration(stats.maxSeconds)+',
          '"</div>"+',
          '"<div class=\\"stats-fastest\\">"+',
          '"Mais rápida: <strong>"+',
          'fmtDuration(fastest.travelTimeSeconds)+',
          '"</strong> · veículo "+',
          'fastest.vehicleId+',
          '(fastest.licensePlate',
          '?" ("+fastest.licensePlate+")"',
          ':"")+',
          '"</div>"+',
          '"</div>";',
          '}).join("");',
          '',
          '}catch(e){',
          'console.error(e);',
          'results.innerHTML="<div class=\\"stats-loading\\">Erro ao obter estatísticas: "+e.message+"</div>";',
          '}',
          '}',
          'async function refresh(){',
          'try{',
          'const r=await fetch("/api/status",{cache:"no-store"});',
          'if(!r.ok)throw new Error("HTTP "+r.status);',
          'const d=await r.json();',
          'document.getElementById("app").innerHTML=d.targets.map(function(t){',
          'const vehicles=t.vehicles||[];',
          'const n=t.next;',
          'if(!n){',
          'const lastPassed=t.lastPassed;',
          'const relative=lastPassed?fmtRelativeTime(lastPassed.passedAt):null;',
          'const lastPassedHtml=relative',
          '  ? "<div class=\\"last-passed\\">Último "+t.routeShortName+" passou há "+relative+"</div>"',
          '  : "";',
          'const isOpen=openTargets.has(t.id);',
          'return "<div class=\\"card\\">"+',
          '"<div class=\\"accordion-header\\" data-target-id=\\""+t.id+"\\">"+',
          '"<div>"+',
          '"<div class=\\"route\\"><strong>"+t.routeShortName+"</strong> · "+t.firstStopName+" → <span class=\\"target-stop\\">"+t.name+"</span> → "+t.destination+"</div>"+',
          'accordionStatus(t)+',
          '"</div>"+',
          '"<div class=\\"accordion-icon "+(isOpen?"open":"")+"\\">›</div>"+',
          '"</div>"+',
          '(isOpen?',
          '"<div class=\\"accordion-content\\">"+',
          '"<div class=\\"none\\"><strong>Sem "+t.routeShortName+" a caminho neste momento</strong><br>A aguardar o próximo veículo."+lastPassedHtml+"</div>"+',
          '"</div>"',
          ':"")+',
          '"</div>";',
          '}',
          'const schedule=scheduleInfo(n,t);',
          'const others=vehicles.slice(1);',
          'const isOpen=openTargets.has(t.id);',
          'return "<div class=\\"card\\">"+',
          '"<div class=\\"accordion-header\\" data-target-id=\\""+t.id+"\\">"+',
                    '"<div class=\\"route\\"><strong>"+t.routeShortName+"</strong> · "+t.firstStopName+" → <span class=\\"target-stop\\">"+t.name+"</span> → "+t.destination+"</div>"+',
          'accordionStatus(t)+',
          '"<div class=\\"accordion-icon "+(isOpen?"open":"")+"\\">›</div>"+',
          '"</div>"+',
          '(isOpen?',
          '"<div class=\\"accordion-content\\">"+',
          'vehicleHtml(n,true,d.updatedAt)+',
          'schedule+',
          '(others.length ? "<div class=\\"others-title\\">OUTROS "+t.routeShortName+"</div>"+',
          'others.map(function(v){',
          'return vehicleHtml(v,false,d.updatedAt)+scheduleInfo(v,t);',
          '}).join("") : "")+',
          '"</div>"',
          ':"")+',
          '"</div>";',
          '}).join("");',
          '}catch(e){',
          'console.error(e);',
          'document.getElementById("app").innerHTML="<div class=\\"card\\">Erro ao obter dados: "+e.message+"</div>";',
          '}',
          '}',
          'document.getElementById("app").addEventListener("click",function(e){',
          'const header=e.target.closest(".accordion-header");',
          'if(!header)return;',
          'toggleTarget(header.dataset.targetId);',
          '});',
          'refresh();',
          'refreshStats();',
          '',
          'document.getElementById("stats-start").addEventListener("change",refreshStats);',
          'document.getElementById("stats-end").addEventListener("change",refreshStats);',
          'document.getElementById("stats-day").addEventListener("change",refreshStats);',
          'document.getElementById("stats-target").addEventListener("change",refreshStats);',
          '',
          'setInterval(refresh,15000);',
          '</script>',
          '</body>',
          '</html>'
        ].join('\n');

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });

        res.end(html);
        return;
      }

      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });

      res.end('Not found');
    });

  server.listen(
    port,
    '0.0.0.0',
    () => {
      console.log(
        '\nServidor web: http://0.0.0.0:' + port
      );
    }
  );
}

// ==========================
// MAIN
// ==========================

async function main() {
  const data =
    await prepareData();

  /*
   * vehicleId:targetId -> {
   *   history: [],
   *   lastSeenAt,
   *   disappeared,
   *   passed,
   *   lastResult
   * }
   */

  const tracker =
    new Map();

  const lastPassedByTarget =
    new Map();

  const tripDepartureTracker =
    new Set();

  let latestStatus = {
    updatedAt: null,
    targets: []
  };

  startWebServer(
    () => latestStatus
  );

  console.log(
    '\n================================================'
  );

  console.log(
    'AUTOCARROS — MONITOR DE PARAGENS'
  );

  console.log(
    '================================================'
  );

  console.log(
    '  749 | Qta. das Freiras → Benfica'
  );

  console.log(
    '  749 | Charquinho → ISEL'
  );

  console.log(
    '  765 | Charquinho → Colégio Militar (Metro)'
  );

  console.log(
    `\nIntervalo: ${POLL_INTERVAL_MS / 1000}s`
  );

  console.log(
    'Pressiona Ctrl+C para terminar.\n'
  );

  while (true) {
    const pollStartedAt =
      Date.now();

    try {
      const vehicles =
        await getVehicles(data);

      const currentKeys =
        new Set(
          vehicles
            .filter(
              v =>
                !v.passedTarget
            )
            .map(
              v =>
                `${v.vehicleId}:${v.targetId}`
            )
        );

      console.log(
        '\n================================================'
      );

      console.log(
        `POLL ${new Date().toLocaleTimeString('pt-PT')}`
      );

      console.log(
        `Candidatos atuais: ${vehicles.length}`
      );

      // ==========================
      // PROCESSAR VE�CULOS
      // ==========================

      for (
        const vehicle of vehicles
      ) {
        const key =
          `${vehicle.vehicleId}:${vehicle.targetId}`;

        if (
          !tracker.has(key)
        ) {
          tracker.set(
            key,
            {
              history: [],
              lastSeenAt: null,
              disappeared: false,
              passed: false,
              lastPassedAt: null,
              lastResult: null
            }
          );
        }

        const state =
          tracker.get(key);

        if (
          vehicle.currentStopSequence >
          vehicle.firstStopSequence &&
          !tripDepartureTracker.has(
            vehicle.tripId
          )
        ) {
          tripDepartureTracker.add(
            vehicle.tripId
          );

          saveTripDeparture(
            vehicle
          );

          console.log(
            `\n[${formatTime(vehicle.timestamp)}] >>> ${vehicle.vehicleId} SAIU DA PRIMEIRA PARAGEM (${vehicle.tripId}) <<<`
          );
        }

        if (
          vehicle.passedTarget
        ) {
          if (
            state.lastResult &&
            !state.passed &&
            state.lastResult.remaining >= 0
          ) {
            state.passed =
              true;

            state.lastResult =
              null;

            savePassageEvent(vehicle);

            lastPassedByTarget.set(
              vehicle.targetId,
              {
                vehicleId:
                  vehicle.vehicleId,
                licensePlate:
                  vehicle.licensePlate,
                passedAt:
                  vehicle.timestamp * 1000
              }
            );

            console.log(
              `\n[${formatTime(vehicle.timestamp)}] >>> ${vehicle.vehicleId} PASSOU ${vehicle.targetName} <<<`
            );
          }

          continue;
        }

        if (
          state.disappeared
        ) {
          console.log(
            `\n[${formatTime(vehicle.timestamp)}] >>> ${vehicle.vehicleId} VOLTOU AO REALTIME (${vehicle.targetName}) <<<`
          );

          state.passed =
            false;
        }

        state.disappeared =
          false;

        const history =
          state.history;

        const lastSample =
          history[
          history.length - 1
          ];

        if (
          !lastSample ||
          lastSample.timestamp !==
          vehicle.timestamp
        ) {
          history.push({
            timestamp:
              vehicle.timestamp,

            shapeDist:
              vehicle.shapeDist,

            remaining:
              vehicle.remaining,

            lat:
              vehicle.lat,

            lon:
              vehicle.lon
          });

          if (
            history.length >
            SPEED_HISTORY_SIZE
          ) {
            history.shift();
          }
        }

        const speeds =
          calculateSpeed(
            history
          );

        const eta =
          calculateEta(
            vehicle.remaining,
            speeds.average
          );

        const result = {
          ...vehicle,

          instantSpeed:
            speeds.instant,

          averageSpeed:
            speeds.average,

          eta
        };

        state.lastSeenAt =
          Date.now();

        state.lastResult =
          result;

        // ==========================
        // PASSAGEM
        // ==========================

        if (
          vehicle.remaining <=
          ARRIVAL_TOLERANCE_M &&
          !state.passed
        ) {
          state.passed =
            true;

          state.lastResult =
            null;

          savePassageEvent(
            vehicle
          );

          lastPassedByTarget.set(
            vehicle.targetId,
            {
              vehicleId:
                vehicle.vehicleId,
              licensePlate:
                vehicle.licensePlate,
              tripId:
                vehicle.tripId,
              scheduledTargetArrivalTime:
                vehicle.scheduledTargetArrivalTime,
              passedAt:
                vehicle.timestamp * 1000
            }
          );

          console.log(
            `\n[${formatTime(vehicle.timestamp)}] >>> ${vehicle.vehicleId} PASSOU ${vehicle.targetName} <<<`
          );

          continue;
        }
        // ==========================
        // LEITURA
        // ==========================

        console.log(
          `\n[${formatTime(vehicle.timestamp)}] ${vehicle.targetName} ? ${vehicle.destination}`
        );

        console.log(
          `  Ve�culo:       ${vehicle.vehicleId}`
        );

        console.log(
          `  Trip:          ${vehicle.tripId}`
        );

        console.log(
          `  Paragem atual:  ${vehicle.currentStopName ??
          `seq ${vehicle.currentStopSequence ?? '—'}`
          }`
        );

        console.log(
          `  Target seq:    ${vehicle.targetStopSequence}`
        );

        console.log(
          `  ShapeDist:     ${vehicle.shapeDist.toFixed(1)} m`
        );

        console.log(
          `  Restante:      ${vehicle.remaining.toFixed(1)} m`
        );

        console.log(
          `  GPS ? shape:   ${vehicle.gpsDistance.toFixed(1)} m`
        );

        console.log(
          `  Vel. instant.: ${speeds.instant === null
            ? '�'
            : speeds.instant.toFixed(1) +
            ' km/h'
          }`
        );

        console.log(
          `  Vel. m�dia:    ${speeds.average === null
            ? 'a recolher dados'
            : speeds.average.toFixed(1) +
            ' km/h'
          }`
        );

        console.log(
          `  ETA:           ${eta === null
            ? 'a recolher dados'
            : formatMinutes(eta)
          }`
        );
      }

      latestStatus =
        buildStatus(
          tracker,
          currentKeys,
          lastPassedByTarget,
          data.targetsByTrip,
          data.calendar,
          data.calendarDates
        );

      // ==========================
      // DESAPARECIDOS
      // ==========================

      for (
        const [
          key,
          state
        ] of tracker
      ) {
        if (
          currentKeys.has(key)
        ) {
          continue;
        }

        if (
          state.disappeared ||
          state.lastSeenAt === null
        ) {
          continue;
        }

        const age =
          Date.now() -
          state.lastSeenAt;

        if (
          age >=
          DISAPPEAR_AFTER_MS
        ) {
          state.disappeared =
            true;

          const last =
            state.lastResult;

          console.log(
            `\n[${new Date().toLocaleTimeString('pt-PT')}] >>> ${key} DESAPARECEU DO REALTIME <<<`
          );

          if (last) {
            console.log(
              `  Paragem:            ${last.targetName} ? ${last.destination}`
            );

            console.log(
              `  �ltima atualiza��o: ${formatTime(last.timestamp)}`
            );

            console.log(
              `  �ltimo ShapeDist:   ${last.shapeDist.toFixed(1)} m`
            );

            console.log(
              `  �ltima dist�ncia:   ${last.remaining.toFixed(1)} m`
            );

            console.log(
              `  �ltima vel. m�dia:  ${last.averageSpeed === null
                ? '�'
                : last.averageSpeed.toFixed(1) +
                ' km/h'
              }`
            );

            console.log(
              `  �ltimo ETA:         ${last.eta === null
                ? '�'
                : formatMinutes(
                  last.eta
                )
              }`
            );
          }

          console.log(
            `  Sem atualiza��o h�: ${formatAge(age / 1000)}`
          );
        }
      }

      // ==========================
      // RESUMO POR PARAGEM
      // ==========================

      for (const target of TARGETS) {
        const active =
          vehicles
            .filter(
              v =>
                v.targetId ===
                target.id
            )
            .map(vehicle => {
              const key =
                `${vehicle.vehicleId}:${vehicle.targetId}`;

              return tracker.get(
                key
              )?.lastResult;
            })
            .filter(Boolean)
            .sort(
              (a, b) =>
                (a.eta ?? Infinity) -
                (b.eta ?? Infinity)
            );

        console.log(
          `\n------------------------------------------------`
        );

        console.log(
          `${target.name} ? ${target.destination}`
        );

        console.log(
          `------------------------------------------------`
        );

        if (
          active.length === 0
        ) {
          console.log(
            '  Nenhum 749 atualmente a caminho.'
          );

          continue;
        }

        const next =
          active[0] ?? null;

        if (next) {
          console.log(
            `  PRÓXIMO: ${next.vehicleId} → ${next.remaining.toFixed(0)} m`
          );

          console.log(
            `  ETA: ${next.eta === null
              ? 'indeterminado'
              : formatMinutes(next.eta)
            }`
          );
        } else {
          console.log(
            '  Nenhum 749 encontrado no realtime neste sentido.'
          );
        }

        console.log(
          '\n  Todos os candidatos:'
        );

        for (
          const vehicle of active
        ) {
          console.log(
            `    ${vehicle.vehicleId} | ${vehicle.remaining.toFixed(0)} m | ${vehicle.averageSpeed === null
              ? 'sem velocidade'
              : vehicle.averageSpeed.toFixed(1) +
              ' km/h'
            } | ETA ${vehicle.eta === null
              ? '�'
              : formatMinutes(
                vehicle.eta
              )
            }`
          );
        }
      }

    } catch (error) {
      console.error(
        '\nERRO NO POLL:'
      );

      console.error(
        error.message
      );
    }

    const elapsed =
      Date.now() -
      pollStartedAt;

    const wait =
      Math.max(
        0,
        POLL_INTERVAL_MS -
        elapsed
      );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          wait
        )
    );
  }
}

main().catch(error => {
  console.error(
    '\nERRO FATAL:'
  );

  console.error(
    error
  );
});
