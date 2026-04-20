const ADDRESS_SEEDS = {
  Texas: {
    Dallas: {
      zipCodes: ['75201', '75204', '75206', '75214'],
      streets: ['2418 Ross Avenue', '3621 Greenville Avenue', '1847 Elm Street', '2710 Swiss Avenue'],
    },
    Frisco: {
      zipCodes: ['75033', '75034', '75035', '75036'],
      streets: ['9550 Preston Road', '2211 Main Street', '4807 Parkwood Boulevard', '6725 Lebanon Road'],
    },
    Houston: {
      zipCodes: ['77002', '77007', '77008', '77019'],
      streets: ['1710 Washington Avenue', '2425 West Alabama Street', '903 Heights Boulevard', '1118 Taft Street'],
    },
  },
  Alabama: {
    Birmingham: {
      zipCodes: ['35203', '35205', '35209', '35213'],
      streets: ['2016 2nd Avenue North', '1431 29th Street South', '825 Green Springs Highway', '3900 Clairmont Avenue'],
    },
    Huntsville: {
      zipCodes: ['35801', '35802', '35805', '35806'],
      streets: ['2414 Memorial Parkway SW', '905 Bob Wallace Avenue', '1312 Meridian Street North', '4800 Whitesburg Drive'],
    },
  },
  Nevada: {
    'Las Vegas': {
      zipCodes: ['89101', '89104', '89109', '89117'],
      streets: ['1821 Fremont Street', '3300 Spring Mountain Road', '4120 South Decatur Boulevard', '2755 West Charleston Boulevard'],
    },
  },
  California: {
    Sacramento: {
      zipCodes: ['95814', '95816', '95818', '95819'],
      streets: ['1417 J Street', '2209 K Street', '3150 Folsom Boulevard', '1825 Capitol Avenue'],
    },
  },
};

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function parseCityState(value = '') {
  const [rawCity = '', rawState = ''] = String(value).split(',');
  return {
    cityName: rawCity.trim(),
    stateName: rawState.trim(),
  };
}

function resolveAddressSeed(cityValue = '', fallbackState = '') {
  const { cityName, stateName } = parseCityState(cityValue);
  const finalState = stateName || String(fallbackState || '').trim();
  const stateData = ADDRESS_SEEDS[finalState];
  if (!stateData) return null;

  if (cityName && stateData[cityName]) {
    return {
      cityName,
      stateName: finalState,
      ...stateData[cityName],
    };
  }

  const [firstCityName] = Object.keys(stateData);
  if (!firstCityName) return null;

  return {
    cityName: firstCityName,
    stateName: finalState,
    ...stateData[firstCityName],
  };
}

function pickRandomSeed() {
  const states = Object.keys(ADDRESS_SEEDS);
  const stateName = pickRandom(states);
  const cities = Object.keys(ADDRESS_SEEDS[stateName]);
  const cityName = pickRandom(cities);
  return { cityName, stateName, ...ADDRESS_SEEDS[stateName][cityName] };
}

function buildPageAddress({ city, state, zipCode } = {}) {
  const seed = resolveAddressSeed(city, state) || pickRandomSeed();
  const parsed = parseCityState(city);

  return {
    streetAddress: pickRandom(seed.streets),
    cityName: parsed.cityName || seed.cityName,
    stateName: parsed.stateName || state || seed.stateName,
    zipCode: String(zipCode || pickRandom(seed.zipCodes)),
  };
}

module.exports = {
  ADDRESS_SEEDS,
  parseCityState,
  resolveAddressSeed,
  buildPageAddress,
};
