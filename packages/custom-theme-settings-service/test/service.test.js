// Switch these lines once there are useful utils
// const testUtils = require('./utils');
require('./utils');

const _ = require('lodash');
const sinon = require('sinon');
const {ValidationError} = require('@tryghost/errors');

const Service = require('../lib/service');
const Cache = require('../lib/cache');

function makeModelInstance(data) {
    const instance = Object.assign({}, data, {
        set: () => {},
        save: async () => {},
        hasChanged: () => {
            return true;
        }
    });

    return sinon.spy(instance);
}

class ModelStub {
    constructor(knownSettings) {
        this.knownSettings = knownSettings.map(makeModelInstance);
        this.nextId = knownSettings.length + 1;
    }

    async findAll(options) {
        let foundSettings = this.knownSettings;

        if (options.filter) {
            // we only use 'theme:{themeName}' in filters
            const [key, value] = options.filter.split(':');
            const matcher = {};
            matcher[key] = value;

            foundSettings = this.knownSettings.filter(_.matches(matcher));
        }

        return {
            toJSON: () => foundSettings
        };
    }

    async findOne(data) {
        return this.knownSettings.find(_.matches(data));
    }

    async add(data) {
        const newSetting = makeModelInstance(Object.assign({}, data, {id: this.nextId}));
        this.knownSettings.push(newSetting);
        this.nextId = this.nextId + 1;
        return newSetting;
    }

    async edit(data, options) {
        const knownSetting = this.knownSettings.find(setting => setting.id === options.id);
        Object.assign(knownSetting, data);
        return knownSetting;
    }

    async destroy(options) {
        const destroyedSetting = this.knownSettings.find(setting => setting.id === options.id);
        this.knownSettings = this.knownSettings.filter(setting => setting !== destroyedSetting);
        return destroyedSetting;
    }
}

describe('Service', function () {
    let service, cache, model;

    beforeEach(function () {
        model = sinon.spy(new ModelStub([{
            id: 1,
            theme: 'test',
            key: 'one',
            type: 'select',
            value: '1'
        }, {
            id: 2,
            theme: 'test',
            key: 'two',
            type: 'select',
            value: '2'
        }]));

        cache = new Cache();

        service = new Service({model, cache});
    });

    describe('activateTheme()', function () {
        it('sets .activeThemeName', function () {
            should(service.activeThemeName).equal(null);

            service.activateTheme({name: 'test'});

            service.activeThemeName.should.equal('test');
        });

        it('handles known settings not seen in theme', async function () {
            await service.activateTheme({
                name: 'test',
                customSettings: {
                    // 'one' custom setting no longer exists
                    // 'two' - no change
                    two: {
                        type: 'select',
                        options: ['2', '3'],
                        default: '2'
                    }
                }
            });

            model.findAll.callCount.should.equal(2);
            model.findAll.getCall(0).firstArg.should.deepEqual({filter: 'theme:test'});
            model.findAll.getCall(1).firstArg.should.deepEqual({filter: 'theme:test'});

            // destroys records that no longer exist in theme
            model.destroy.callCount.should.equal(1);
            model.destroy.getCall(0).firstArg.should.deepEqual({id: 1});

            // internal cache is correct
            service.listSettings().should.deepEqual([{
                id: 2,
                key: 'two',
                type: 'select',
                options: ['2', '3'],
                default: '2',
                value: '2'
            }]);

            // external cache is correct
            cache.getAll().should.deepEqual({
                two: '2'
            });
        });

        it('handles known settings that change type', async function () {
            await service.activateTheme({
                name: 'test',
                customSettings: {
                    // no change
                    one: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '2'
                    },
                    // switch from select to boolean
                    two: {
                        type: 'boolean',
                        default: true
                    }
                }
            });

            // destroys and recreates record
            model.destroy.callCount.should.equal(1);
            model.destroy.getCall(0).firstArg.should.deepEqual({id: 2});

            model.add.callCount.should.equal(1);
            model.add.getCall(0).firstArg.should.deepEqual({
                theme: 'test',
                key: 'two',
                type: 'boolean',
                value: true
            });

            // internal cache is correct
            service.listSettings().should.deepEqual([{
                id: 1,
                key: 'one',
                type: 'select',
                options: ['1', '2'],
                default: '2',
                value: '1'
            }, {
                id: 3,
                key: 'two',
                type: 'boolean',
                default: true,
                value: true
            }]);

            // external cache is correct
            cache.getAll().should.deepEqual({
                one: '1',
                two: true
            });
        });

        it('handles value of select not matching updated options', async function () {
            await service.activateTheme({
                name: 'test',
                customSettings: {
                    // no change
                    one: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '2'
                    },
                    // current value is '2' which doesn't match new options
                    two: {
                        type: 'select',
                        options: ['one', 'two'],
                        default: 'two'
                    }
                }
            });

            // updates known setting to match new default
            model.edit.callCount.should.equal(1);
            model.edit.getCall(0).firstArg.should.deepEqual({value: 'two'});
            model.edit.getCall(0).lastArg.should.deepEqual({id: 2, method: 'update'});
        });

        it('handles new settings', async function () {
            await service.activateTheme({
                name: 'test',
                customSettings: {
                    // no change
                    one: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '2'
                    },
                    // no change
                    two: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '1'
                    },
                    // new setting
                    three: {
                        type: 'select',
                        options: ['uno', 'dos', 'tres'],
                        default: 'tres'
                    }
                }
            });

            // new setting is created
            model.add.callCount.should.equal(1);
            model.add.getCall(0).firstArg.should.deepEqual({
                theme: 'test',
                key: 'three',
                type: 'select',
                value: 'tres'
            });

            // internal cache is correct
            service.listSettings().should.deepEqual([{
                id: 1,
                key: 'one',
                type: 'select',
                options: ['1', '2'],
                default: '2',
                value: '1'
            }, {
                id: 2,
                key: 'two',
                type: 'select',
                options: ['1', '2'],
                default: '1',
                value: '2'
            }, {
                id: 3,
                key: 'three',
                type: 'select',
                options: ['uno', 'dos', 'tres'],
                default: 'tres',
                value: 'tres'
            }]);

            // external cache is correct
            cache.getAll().should.deepEqual({
                one: '1',
                two: '2',
                three: 'tres'
            });
        });

        it('handles activation of new theme when already activated', async function () {
            // activate known theme
            await service.activateTheme({
                name: 'test',
                customSettings: {
                    one: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '2'
                    },
                    two: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '1'
                    }
                }
            });

            // activate new theme
            await service.activateTheme({
                name: 'new',
                customSettings: {
                    typography: {
                        type: 'select',
                        options: ['Serif', 'Sans-serif'],
                        default: 'Sans-serif'
                    },
                    full_cover_image: {
                        type: 'boolean',
                        default: true,
                        group: 'post'
                    }
                }
            });

            // looks for existing settings, then re-fetches after sync. Twice for each activation
            model.findAll.callCount.should.equal(4);
            model.findAll.getCall(0).firstArg.should.deepEqual({filter: 'theme:test'});
            model.findAll.getCall(1).firstArg.should.deepEqual({filter: 'theme:test'});
            model.findAll.getCall(2).firstArg.should.deepEqual({filter: 'theme:new'});
            model.findAll.getCall(3).firstArg.should.deepEqual({filter: 'theme:new'});

            // adds new settings
            model.add.callCount.should.equal(2);

            model.add.firstCall.firstArg.should.deepEqual({
                theme: 'new',
                key: 'typography',
                type: 'select',
                value: 'Sans-serif'
            });

            model.add.secondCall.firstArg.should.deepEqual({
                theme: 'new',
                key: 'full_cover_image',
                type: 'boolean',
                value: true
            });

            // internal cache is correct
            service.listSettings().should.deepEqual([{
                id: 3,
                key: 'typography',
                type: 'select',
                options: ['Serif', 'Sans-serif'],
                default: 'Sans-serif',
                value: 'Sans-serif'
            }, {
                id: 4,
                key: 'full_cover_image',
                type: 'boolean',
                default: true,
                value: true,
                group: 'post'
            }]);

            // external cache is correct
            cache.getAll().should.deepEqual({
                typography: 'Sans-serif',
                full_cover_image: true
            });
        });

        it('exits early if both repository and theme have no settings', async function () {
            await service.activateTheme({
                name: 'no-custom'
            });

            model.findAll.callCount.should.equal(1);
        });
    });

    describe('listSettings()', function () {
        it('returns empty array when internal cache is empty', function () {
            service.listSettings().should.deepEqual([]);
        });
    });

    describe('updateSettings()', function () {
        it('saves new values', async function () {
            // activate theme so settings are loaded in internal cache
            await service.activateTheme({
                name: 'test',
                customSettings: {
                    one: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '2'
                    },
                    two: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '1'
                    }
                }
            });

            // update settings
            const result = await service.updateSettings([{
                id: 1,
                key: 'one',
                type: 'select',
                options: ['1', '2'],
                default: '2',
                value: '2' // was '1'
            }, {
                id: 2,
                key: 'two',
                type: 'select',
                options: ['1', '2'],
                default: '1',
                value: '1' // was '2'
            }]);

            // set + save called on each record
            const firstRecord = model.knownSettings.find(s => s.id === 1);
            firstRecord.set.calledOnceWith('value', '2').should.be.true();
            firstRecord.save.calledOnceWith(null).should.be.true();

            const secondRecord = model.knownSettings.find(s => s.id === 2);
            secondRecord.set.calledOnceWith('value', '1').should.be.true();
            secondRecord.save.calledOnceWith(null).should.be.true();

            // return value is correct
            result.should.deepEqual([{
                id: 1,
                key: 'one',
                type: 'select',
                options: ['1', '2'],
                default: '2',
                value: '2'
            }, {
                id: 2,
                key: 'two',
                type: 'select',
                options: ['1', '2'],
                default: '1',
                value: '1'
            }]);

            // internal cache is correct
            service.listSettings().should.deepEqual([{
                id: 1,
                key: 'one',
                type: 'select',
                options: ['1', '2'],
                default: '2',
                value: '2'
            }, {
                id: 2,
                key: 'two',
                type: 'select',
                options: ['1', '2'],
                default: '1',
                value: '1'
            }]);

            // external cache is correct
            cache.getAll().should.deepEqual({
                one: '2',
                two: '1'
            });
        });

        it('ignores everything except keys and values', async function () {
            // activate theme so settings are loaded in internal cache
            await service.activateTheme({
                name: 'test',
                customSettings: {
                    one: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '2'
                    },
                    two: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '1'
                    }
                }
            });

            // update settings
            const result = await service.updateSettings([{
                id: 10, // was 1
                key: 'one',
                type: 'unknown', // was 'select'
                options: ['10', '20'], // was ['1', '2']
                default: '20', // was '20'
                value: '2' // was '1'
            }, {
                id: 20, // was 2
                key: 'two',
                type: 'unknown', // was 'select'
                options: ['10', '20'], // was ['1', '2']
                default: '10', // was '1'
                value: '1' // was '2'
            }]);

            // set + save called on each record
            const firstRecord = model.knownSettings.find(s => s.id === 1);
            firstRecord.set.calledOnceWith('value', '2').should.be.true();
            firstRecord.save.calledOnceWith(null).should.be.true();

            const secondRecord = model.knownSettings.find(s => s.id === 2);
            secondRecord.set.calledOnceWith('value', '1').should.be.true();
            secondRecord.save.calledOnceWith(null).should.be.true();

            // return value is correct
            result.should.deepEqual([{
                id: 1, // change not applied
                key: 'one',
                type: 'select', // change not applied
                options: ['1', '2'], // change not applied
                default: '2', // change not applied
                value: '2'
            }, {
                id: 2, // change not applied
                key: 'two',
                type: 'select', // change not applied
                options: ['1', '2'], // change not applied
                default: '1', // change not applied
                value: '1'
            }]);

            // internal cache is correct
            service.listSettings().should.deepEqual([{
                id: 1,
                key: 'one',
                type: 'select',
                options: ['1', '2'],
                default: '2',
                value: '2'
            }, {
                id: 2,
                key: 'two',
                type: 'select',
                options: ['1', '2'],
                default: '1',
                value: '1'
            }]);

            // external cache is correct
            cache.getAll().should.deepEqual({
                one: '2',
                two: '1'
            });
        });

        it('errors on unknown setting', async function () {
            // activate theme so settings are loaded in internal cache
            await service.activateTheme({
                name: 'test',
                customSettings: {
                    one: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '2'
                    },
                    two: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '1'
                    }
                }
            });

            // update with known and unknown keys
            await service.updateSettings(
                [{
                    id: 1,
                    key: 'one',
                    type: 'select',
                    options: ['1', '2'],
                    default: '2',
                    value: '1'
                }, {
                    id: 2,
                    key: 'test',
                    type: 'select',
                    options: ['valid', 'invalid'],
                    default: 'valid',
                    value: 'invalid'
                }]
            ).should.be.rejectedWith(ValidationError, {message: 'Unknown setting: test.'});
        });

        it('errors on invalid select value', async function () {
            // activate theme so settings are loaded in internal cache
            await service.activateTheme({
                name: 'test',
                customSettings: {
                    one: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '2'
                    },
                    two: {
                        type: 'select',
                        options: ['1', '2'],
                        default: '1'
                    }
                }
            });

            // update with invalid option value
            await service.updateSettings(
                [{
                    id: 1,
                    key: 'one',
                    type: 'select',
                    options: ['1', '2'],
                    default: '2',
                    value: 'invalid'
                }]
            ).should.be.rejectedWith(ValidationError, {message: 'Invalid value for \'one\'. Allowed values: 1, 2.'});
        });
    });
});