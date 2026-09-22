const http = require('http');
const Adm = require('adm-zip');
const { FeedMessage } =
  require('gtfs-realtime-bindings').transit_realtime;

const GTFS_URL =
  'https://gateway.carris.pt/gateway/gtfs/api/v2.11/GTFS';

const RT_URL =
  'https://gateway.carris.pt/gateway/gtfs/api/v2.11/GTFS/realtime/vehiclepositions';

const ROUTE_ID = '195_0';

const TARGETS = [
  {
    id: 'qta-freiras',
    name: 'Qta. das Freiras',
    stopId: '3314',
    destination: 'Benfica'
  },
  {
    id: 'charquinho',
    name: 'Charquinho',
    stopId: '13705',
    destination: 'ISEL'
  }
];

const POLL_INTERVAL_MS = 30000;

const ARRIVAL_TOLERANCE_M = 10;

const DISAPPEAR_AFTER_MS = 45000;

const SPEED_HISTORY_SIZE = 5;

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

function readCsv(zip, filename) {
  const text =
    zip.readAsText(filename);

  const lines =
    text
      .split(/\r?\n/)
      .filter(Boolean);

  const header =
    lines[0].split(',');

  return {
    header,
    rows: lines.slice(1).map(
      line => line.split(',')
    )
  };
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

  const routes =
    readCsv(zip, 'routes.txt');

  const routeIdIndex =
    routes.header.indexOf('route_id');

  const routeShortNameIndex =
    routes.header.indexOf('route_short_name');

  const routeLongNameIndex =
    routes.header.indexOf('route_long_name');

  const route =
    routes.rows.find(row =>
      row[routeIdIndex] === ROUTE_ID &&
      row[routeShortNameIndex] === '749'
    );

  if (!route) {
    throw new Error(
      'Rota 749 n�o encontrada.'
    );
  }

  console.log(
    `Rota: ${route[routeShortNameIndex]} � ${route[routeLongNameIndex]}`
  );

  // ==========================
  // TRIPS
  // ==========================

  const trips =
    readCsv(zip, 'trips.txt');

  const tripRouteIndex =
    trips.header.indexOf('route_id');

  const tripIdIndex =
    trips.header.indexOf('trip_id');

  const shapeIdIndex =
    trips.header.indexOf('shape_id');

  const directionIdIndex =
    trips.header.indexOf('direction_id');

  const routeTrips =
    new Map();

  for (const row of trips.rows) {
    if (
      row[tripRouteIndex] !==
      ROUTE_ID
    ) {
      continue;
    }

    routeTrips.set(
      row[tripIdIndex],
      {
        tripId:
          row[tripIdIndex],

        shapeId:
          row[shapeIdIndex],

        directionId:
          row[directionIdIndex]
      }
    );
  }

  // ==========================
  // STOP TIMES
  // ==========================

  const stopTimes =
    readCsv(zip, 'stop_times.txt');

  const stTripIdIndex =
    stopTimes.header.indexOf('trip_id');

  const stStopIdIndex =
    stopTimes.header.indexOf('stop_id');

  const stSequenceIndex =
    stopTimes.header.indexOf(
      'stop_sequence'
    );

  const stShapeDistIndex =
    stopTimes.header.indexOf(
      'shape_dist_traveled'
    );

  const stopTimesByTrip =
    new Map();

  for (const row of stopTimes.rows) {
    const tripId =
      row[stTripIdIndex];

    if (
      !routeTrips.has(tripId)
    ) {
      continue;
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
          )
      });
  }

  for (
    const stops of
    stopTimesByTrip.values()
  ) {
    stops.sort(
      (a, b) =>
        a.sequence - b.sequence
    );
  }

  // ==========================
  // SHAPES
  // ==========================

  const shapes =
    readCsv(zip, 'shapes.txt');

  const shapeIdColumn =
    shapes.header.indexOf(
      'shape_id'
    );

  const shapeLatIndex =
    shapes.header.indexOf(
      'shape_pt_lat'
    );

  const shapeLonIndex =
    shapes.header.indexOf(
      'shape_pt_lon'
    );

  const shapeSeqIndex =
    shapes.header.indexOf(
      'shape_pt_sequence'
    );

  const shapeDistIndex =
    shapes.header.indexOf(
      'shape_dist_traveled'
    );

  const shapesById =
    new Map();

  for (const row of shapes.rows) {
    const shapeId =
      row[shapeIdColumn];

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
    for (
      const [
        tripId,
        stops
      ] of stopTimesByTrip
    ) {
      const targetStop =
        stops.find(
          stop =>
            stop.stopId ===
            target.stopId
        );

      if (!targetStop) {
        continue;
      }

      if (
        !targetsByTrip.has(tripId)
      ) {
        targetsByTrip.set(
          tripId,
          []
        );
      }

      targetsByTrip
        .get(tripId)
        .push({
          targetId:
            target.id,

          targetName:
            target.name,

          destination:
            target.destination,

          stopId:
            target.stopId,

          stopSequence:
            targetStop.sequence,

          targetShapeDist:
            targetStop.shapeDist
        });
    }
  }

  console.log('\nTargets configurados:');

  for (const target of TARGETS) {
    const count =
      [...targetsByTrip.values()]
        .filter(targets =>
          targets.some(
            t =>
              t.targetId ===
              target.id
          )
        ).length;

    console.log(
      `  ${target.name} ? ${target.destination}: ${count} trips`
    );
  }

  return {
    routeTrips,
    stopTimesByTrip,
    targetsByTrip,
    shapesById
  };
}

// ==========================
// DETERMINAR SENTIDO DO TRIP
// ==========================

function getTripDirection(stops) {
  if (
    !stops ||
    stops.length < 2
  ) {
    return null;
  }

  const first =
    stops[0];

  const last =
    stops[stops.length - 1];

  if (
    !Number.isFinite(
      first.shapeDist
    ) ||
    !Number.isFinite(
      last.shapeDist
    )
  ) {
    return null;
  }

  if (
    last.shapeDist >
    first.shapeDist
  ) {
    return 1;
  }

  if (
    last.shapeDist <
    first.shapeDist
  ) {
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
      data.routeTrips.get(
        tripId
      );

    if (!trip) {
      continue;
    }

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

      /*
       * Se o ve�culo j� passou o target,
       * n�o � candidato a esta paragem.
       */
      if (remaining < -ARRIVAL_TOLERANCE_M) {
        continue;
      }

      vehicles.push({
        targetId:
          target.targetId,

        targetName:
          target.targetName,

        destination:
          target.destination,

        vehicleId:
          vehicle.vehicle.id,

        tripId,

        direction,

        directionId:
          trip.directionId,

        currentStopSequence:
          vehicle.currentStopSequence,

        targetStopSequence:
          target.stopSequence,

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
  if (
    history.length < 2
  ) {
    return {
      instant: null,
      average: null
    };
  }

  const previous =
    history[
      history.length - 2
    ];

  const current =
    history[
      history.length - 1
    ];

  const dt =
    current.timestamp -
    previous.timestamp;

  const dd =
    Math.abs(
      current.shapeDist -
      previous.shapeDist
    );

  let instant = null;

  if (
    dt > 0 &&
    dd >= 0
  ) {
    instant =
      (dd / dt) * 3.6;
  }

  const recent =
    history.slice(
      -SPEED_HISTORY_SIZE
    );

  const first =
    recent[0];

  const last =
    recent[
      recent.length - 1
    ];

  const totalDt =
    last.timestamp -
    first.timestamp;

  const totalDd =
    Math.abs(
      last.shapeDist -
      first.shapeDist
    );

  let average = null;

  if (
    totalDt > 0 &&
    totalDd >= 0
  ) {
    average =
      (totalDd / totalDt) * 3.6;
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

function buildStatus(tracker, currentKeys) {
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
            (a.eta ?? Infinity) -
            (b.eta ?? Infinity)
        );

      const next =
        vehicles.find(
          vehicle =>
            vehicle.eta !== null
        );

      return {
        id: target.id,
        name: target.name,
        destination: target.destination,

        next: next
          ? {
              vehicleId: next.vehicleId,
              etaSeconds: next.eta,
              remainingMeters: next.remaining,
              averageSpeedKmh: next.averageSpeed,
              timestamp: next.timestamp
            }
          : null,

        vehicles: vehicles.map(vehicle => ({
          vehicleId: vehicle.vehicleId,
          etaSeconds: vehicle.eta,
          remainingMeters: vehicle.remaining,
          averageSpeedKmh: vehicle.averageSpeed,
          timestamp: vehicle.timestamp
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
          '<title>749 — Monitor</title>',
          '<style>',
          'body{font-family:system-ui,sans-serif;margin:0;padding:20px;background:#f5f5f5;color:#111}',
          'main{max-width:520px;margin:auto}',
          'h1{font-size:28px;margin:0 0 20px}',
          '.card{background:white;border-radius:16px;padding:18px;margin-bottom:16px;box-shadow:0 2px 8px #0001}',
          '.route{font-size:15px;color:#555;margin-bottom:8px}',
          '.eta{font-size:42px;font-weight:700;margin:8px 0}',
          '.meta{font-size:15px;line-height:1.7}',
          '.small{color:#777;font-size:13px;margin-top:14px}',
          '.none{font-size:18px;color:#777}',
          '</style>',
          '</head>',
          '<body>',
          '<main>',
          '<h1>749</h1>',
          '<div id="app">A carregar...</div>',
          '</main>',
          '<script>',
          'function fmtEta(s){if(s==null)return "A recolher dados";if(s<60)return Math.round(s)+" s";return Math.floor(s/60)+" min "+Math.round(s%60)+" s";}',
          'function age(t){if(!t)return "";return "Atualizado há "+Math.round(Math.max(0,(Date.now()-t*1000)/1000))+" s";}',
          'async function refresh(){',
          'try{',
          'const r=await fetch("/api/status",{cache:"no-store"});',
          'const d=await r.json();',
          'document.getElementById("app").innerHTML=d.targets.map(function(t){',
          'var n=t.next;',
          'return "<div class=\"card\">"+',
          '"<div class=\"route\">"+t.name+" → "+t.destination+"</div>"+',
          '(n ? "<div class=\"eta\">"+fmtEta(n.etaSeconds)+"</div>"+',
          '"<div class=\"meta\">Veículo: <b>"+n.vehicleId+"</b><br>"+',
          '"Distância: "+Math.round(n.remainingMeters)+" m<br>"+',
          '"Velocidade: "+(n.averageSpeedKmh==null?"a recolher":n.averageSpeedKmh.toFixed(1)+" km/h")+"</div>"+',
          '"<div class=\"small\">"+age(n.timestamp)+"</div>" :',
          '"<div class=\"none\">Nenhum 749 atualmente a caminho.</div>")+"</div>";',
          '}).join("");',
          '}catch(e){document.getElementById("app").innerHTML="<div class=\"card\">Erro ao obter dados.</div>";}',
          '}',
          'refresh();',
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
    '749 � MONITOR DE PARAGENS'
  );

  console.log(
    '================================================'
  );

  console.log(
    '  Qta. das Freiras ? Benfica'
  );

  console.log(
    '  Charquinho ? ISEL'
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
          vehicles.map(
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
              lastResult: null
            }
          );
        }

        const state =
          tracker.get(key);

        if (
          state.disappeared
        ) {
          console.log(
            `\n[${formatTime(vehicle.timestamp)}] >>> ${vehicle.vehicleId} VOLTOU AO REALTIME (${vehicle.targetName}) <<<`
          );
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

          console.log(
            `\n[${formatTime(vehicle.timestamp)}] >>> ${vehicle.vehicleId} PASSOU ${vehicle.targetName} <<<`
          );
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
          `  Current seq:   ${vehicle.currentStopSequence ?? '�'}`
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
          `  Vel. instant.: ${
            speeds.instant === null
              ? '�'
              : speeds.instant.toFixed(1) +
                ' km/h'
          }`
        );

        console.log(
          `  Vel. m�dia:    ${
            speeds.average === null
              ? 'a recolher dados'
              : speeds.average.toFixed(1) +
                ' km/h'
          }`
        );

        console.log(
          `  ETA:           ${
            eta === null
              ? 'a recolher dados'
              : formatMinutes(eta)
          }`
        );
      }

      latestStatus =
        buildStatus(
          tracker,
          currentKeys
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
              `  �ltima vel. m�dia:  ${
                last.averageSpeed === null
                  ? '�'
                  : last.averageSpeed.toFixed(1) +
                    ' km/h'
              }`
            );

            console.log(
              `  �ltimo ETA:         ${
                last.eta === null
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
          active.find(
            v =>
              v.eta !== null
          );

        if (next) {
          console.log(
            `  PR�XIMO: ${next.vehicleId} ? ${formatMinutes(next.eta)}`
          );
        } else {
          console.log(
            '  PR�XIMO: a recolher velocidade...'
          );
        }

        console.log(
          '\n  Todos os candidatos:'
        );

        for (
          const vehicle of active
        ) {
          console.log(
            `    ${vehicle.vehicleId} | ${vehicle.remaining.toFixed(0)} m | ${
              vehicle.averageSpeed === null
                ? 'sem velocidade'
                : vehicle.averageSpeed.toFixed(1) +
                  ' km/h'
            } | ETA ${
              vehicle.eta === null
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
