const TEST_MODELS = {
  // london: { basic: 'ecmwf_ifs025', additional: 'icon_seamless', test: '' },
  // beijing: { basic: 'cma_grapes_global', additional: '', test: '' },
  // paris: { basic: 'meteofrance_seamless', additional: '', test: '' },
  // dallas: { basic: 'gfs_seamless', additional: '', test: '' },
  // taipei: { basic: '', additional: '', test: '' },
  // seoul: { basic: '', additional: '', test: '' },
  // hongkong: { basic: '', additional: '', test: '' },
  // singapore: { basic: '', additional: '', test: '' },
  // milan: { basic: '', additional: '', test: '' },
  // madrid: { basic: '', additional: '', test: '' },
  // shanghai: { basic: '', additional: '', test: '' },
  // miami: { basic: '', additional: '', test: '' },
  // ankara: { basic: '', additional: '', test: '' },
  // saopaulo: { basic: '', additional: '', test: '' },
  // chongqing: { basic: '', additional: '', test: '' },
  // chengdu: { basic: '', additional: '', test: '' },
  // nyc: { basic: '', additional: '', test: '' },
  // warsaw: { basic: '', additional: '', test: '' },
  // munich: { basic: '', additional: '', test: '' },
  // atlanta: { basic: '', additional: '', test: '' },
  // amsterdam: { basic: '', additional: '', test: '' },
  // moscow: { basic: '', additional: '', test: '' },
  // toronto: { basic: '', additional: '', test: '' },
  // tokyo: { basic: '', additional: '', test: '' },
  // istanbul: { basic: '', additional: '', test: '' },
  // kualalumpur: { basic: '', additional: '', test: '' },
  // wuhan: { basic: '', additional: '', test: '' },
  // losangeles: { basic: '', additional: '', test: '' },
  // guangzhou: { basic: '', additional: '', test: '' },
  // lucknow: { basic: '', additional: '', test: '' },
  // buenosaires: { basic: '', additional: '', test: '' },
  // busan: { basic: '', additional: '', test: '' },
  // capetown: { basic: '', additional: '', test: '' },
  // telaviv: { basic: '', additional: '', test: '' },
  // manila: { basic: '', additional: '', test: '' },
  // qingdao: { basic: '', additional: '', test: '' },
  // sanfrancisco: { basic: '', additional: '', test: '' },
  // denver: { basic: '', additional: '', test: '' },
  // mexicocity: { basic: '', additional: '', test: '' },
  // seattle: { basic: '', additional: '', test: '' },
  // wellington: { basic: '', additional: '', test: '' },
  // austin: { basic: '', additional: '', test: '' },
  // shenzhen: { basic: '', additional: '', test: '' },
  // chicago: { basic: '', additional: '', test: '' },
  // helsinki: { basic: '', additional: '', test: '' },
  // jeddah: { basic: '', additional: '', test: '' },
  // houston: { basic: '', additional: '', test: '' },
  // karachi: { basic: '', additional: '', test: '' },
  // panamacity: { basic: '', additional: '', test: '' },
};

function getTestModels(cityId) {
  return TEST_MODELS[cityId] || { basic: '', additional: '', test: '' };
}

function getAllConfiguredTestModels(cityId) {
  const models = getTestModels(cityId);
  return ['basic', 'additional', 'test']
    .map((key) => models[key])
    .filter((id) => id && typeof id === 'string' && id.length > 0);
}

function setTestModels(cityId, models) {
  if (!cityId || typeof cityId !== 'string') return;
  TEST_MODELS[cityId] = {
    basic: (models && typeof models.basic === 'string') ? models.basic : '',
    additional: (models && typeof models.additional === 'string') ? models.additional : '',
    test: (models && typeof models.test === 'string') ? models.test : '',
  };
}

module.exports = { TEST_MODELS, getTestModels, getAllConfiguredTestModels, setTestModels };
