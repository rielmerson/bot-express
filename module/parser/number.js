"use strict";

const debug = require("debug")("bot-express:parser");

module.exports = class ParserNumber {
    /**
     * @constructor
     * @param {Object} [options]
     */
    constructor(options){
        this.type = "number";
        this.required_options = [];

        for (let required_option of this.required_options){
            if (!options[required_option]){
                throw new Error(`Required option "${required_option}" not set.`);
            }
        }
    }

    /**
     * @method
     * @param {*} value
     * @param {Object} [policy]
     * @param {Number} [policy.min]
     * @param {Number} [policy.max]
     * @return {String} - Parsed value.
     */
    async parse(value, policy = {}){
        let parsed_value = parseInt(value);

        if (isNaN(parsed_value)){
            // Check if this is postback and numberable value is set in value.data.
            if (typeof value == "object"){
                parsed_value = parseInt(value.data);
            }

            // Check once again and throw error if it is still NaN.
            if (isNaN(parsed_value)){
                throw new Error("should_be_number");
            }
        }

        if (policy.min){
            if (parsed_value < policy.min){
                throw new Error("violates_min");
            }
        }

        if (policy.max){
            if (parsed_value> policy.max){
                throw new Error("violates_max");
            }
        }

        return parsed_value;
    }
}
